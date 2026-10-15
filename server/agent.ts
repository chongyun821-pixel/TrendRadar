/** 모든 채팅 모델이 함께 쓰는 도구 정의·실행·프롬프트·액션 블록 파서 (Workers/Node 공통, Node 전용 import 없음) */
import { TOOL_IMPLS, writeReport } from '../shared/tools';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';

export type ModelId = 'grok' | 'codex' | 'gemma' | 'nemotron';
export interface ChatIn { model?: string; messages: { role: 'user' | 'model'; text: string }[]; state?: { mode?: string | null; flat?: boolean; focus?: string | null } }
export interface ChatOut { reply: string; actions: Record<string, unknown>[]; reports: string[]; tools: string[]; model?: string; usage?: { input: number; cached: number; output: number }; nokey?: boolean; error?: string; detail?: string }
export const newOut = (): ChatOut => ({ reply: '', actions: [], reports: [], tools: [] });

type P = { type: 'string' | 'integer' | 'boolean'; description?: string };
export interface ToolDef { name: string; description: string; properties: Record<string, P>; required?: string[] }
const S = (description: string): P => ({ type: 'string', description });

/** 단일 정의 → Gemini functionDeclarations / OpenAI tools 로 변환 */
export const TOOL_DEFS: ToolDef[] = [
  { name: 'set_mode', description: '히트맵 모드 변경', properties: { system: S('일반|자주포|장갑차|대공미사일|다연장로켓|호위함|재래식 잠수함') }, required: ['system'] },
  { name: 'toggle_map_mode', description: '3D 지구본과 2D 지도 전환', properties: { flat: { type: 'boolean', description: 'true=2D 지도, false=3D 지구본, 생략=전환' } } },
  { name: 'focus_country', description: '카메라를 국가로 이동', properties: { country: S('국가명') }, required: ['country'] },
  { name: 'get_forecast', description: '국가·체계의 예상 교체 시기·수량·금액(예측)과 계산 과정', properties: { country: S('국가명'), system: S('체계(생략 시 전체)') }, required: ['country'] },
  { name: 'list_forecasts', description: '체계별 임박 순 예측 목록', properties: { system: S('체계'), limit: { type: 'integer' } } },
  { name: 'search_programs', description: '보유 장비·최근 계약·사업 계획 조회', properties: { country: S('국가명'), system: S('체계') } },
  { name: 'get_lifespan', description: '설계 수명과 모델별 교체 시점', properties: { system: S('체계'), model: S('모델명 일부') } },
  { name: 'search_mro', description: '정비·성능개량·수명연장 기록', properties: { country: S('국가명'), model: S('모델명 일부') } },
  { name: 'write_report', description: '국가 보고서 작성(화면에 자동 표시)', properties: { country: S('국가명'), system: S('체계(생략 시 전체)') }, required: ['country'] },
];
export const PAGE_TOOLS = new Set(['set_mode', 'toggle_map_mode', 'focus_country', 'write_report']);

export const geminiDeclarations = () => TOOL_DEFS.map(t => ({
  name: t.name, description: t.description,
  parameters: { type: 'OBJECT', properties: Object.fromEntries(Object.entries(t.properties).map(([k, p]) => [k, { ...p, type: p.type.toUpperCase() }])), ...(t.required ? { required: t.required } : {}) },
}));
export const openaiTools = () => TOOL_DEFS.map(t => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: { type: 'object', properties: t.properties, ...(t.required ? { required: t.required } : {}) } },
}));

export function systemPrompt(st: ChatIn['state']) {
  const countries = Object.values(seed.countries).map(c => c.ko).join(', ');
  return [
    '너는 「무기조달사업예상」 웹앱의 한국어 도우미다. 지구본 히트맵으로 각국 무기 교체 사업 시기·규모를 예측한다.',
    '규칙: 수치는 도구 결과만 쓰고 지어내지 않는다. 예측은 "예측", 추정값은 "추정"으로 밝힌다. 답은 짧게(최대 5줄).',
    '화면 변경 요청은 set_mode/toggle_map_mode/focus_country. 특정 국가 질문엔 focus_country도 호출. 보고서 요청은 write_report 후 한 문장만 답한다.',
    `데이터 국가: ${countries}.`,
    `현재 화면: 모드=${st?.mode ? seed.systems[st.mode as keyof typeof seed.systems]?.ko ?? st.mode : '일반'}, 지도=${st?.flat ? '2D' : '3D'}, 선택=${st?.focus ?? '없음'}.`,
  ].join('\n');
}

/** 대화 기록 정리: 최근 7개, 마지막은 user */
export function recentMessages(input: ChatIn) {
  return (input.messages ?? []).slice(-7).filter(m => m && m.text).map(m => ({ role: m.role === 'model' ? 'model' as const : 'user' as const, text: String(m.text).slice(0, 1500) }));
}

export const trim = (v: unknown, n = 3500) => { const s = JSON.stringify(v) ?? 'null'; return s.length > n ? { truncated: true, text: s.slice(0, n) } : v; };

export function runTool(name: string, args: Record<string, any>, out: ChatOut): unknown {
  args = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'set_mode': {
      const s = isGeneral(args.system) || args.system == null || args.system === '' ? null : resolveSystem(args.system);
      if (!s && !(isGeneral(args.system) || args.system == null || args.system === '')) return { ok: false, error: '체계 이름 확인' };
      out.actions.push({ type: 'set_mode', system: s }); return { ok: true, mode: s ? seed.systems[s].ko : '일반' };
    }
    case 'toggle_map_mode': out.actions.push({ type: 'toggle_map_mode', ...(typeof args.flat === 'boolean' ? { flat: args.flat } : {}) }); return { ok: true };
    case 'focus_country': {
      const c = resolveCountry(args.country);
      out.actions.push({ type: 'focus_country', country: c ?? String(args.country ?? '') });
      return { ok: true, country: c ? seed.countries[c].ko : args.country, inData: !!c };
    }
    case 'write_report': {
      const r = writeReport(args);
      if ('error' in r) return r;
      out.reports.push(r.markdown);
      if (r.country) out.actions.push({ type: 'focus_country', country: r.country });
      return { ok: true, shown: true, summary: r.markdown.split('\n').filter(l => l.startsWith('- ')).slice(0, 4).join(' ') };
    }
    default: {
      const f = TOOL_IMPLS[name];
      if (!f) return { error: `알 수 없는 도구 ${name}` };
      try { return f(args); } catch (e) { return { error: String(e) }; }
    }
  }
}

/* ───────── 텍스트 액션 블록 (CLI 모델·도구 미지원 모델용) ───────── */

const ALIAS: Record<string, string> = { report: 'write_report', mode: 'set_mode', focus: 'focus_country', country: 'focus_country', map: 'toggle_map_mode', forecast: 'get_forecast' };
export interface ToolCall { name: string; args: Record<string, any> }
const KNOWN = new Set([...TOOL_DEFS.map(t => t.name), 'get_inventory']);

function normCall(x: any): ToolCall | null {
  if (!x || typeof x !== 'object') return null;
  let name = String(x.name ?? x.type ?? x.tool ?? x.action ?? '').trim();
  name = ALIAS[name] ?? name;
  if (!KNOWN.has(name)) return null;
  const rest = { ...x }; delete rest.name; delete rest.type; delete rest.tool; delete rest.action;
  const args = x.args && typeof x.args === 'object' ? x.args : x.arguments && typeof x.arguments === 'object' ? x.arguments : rest;
  return { name, args };
}

/** 응답 끝의 ```json {...}``` 블록(또는 맨 끝 {..."actions"...})을 찾아 호출 목록과 블록을 뺀 본문을 돌려준다 */
export function parseActionBlock(text: string): { text: string; calls: ToolCall[] } {
  const src = String(text ?? '');
  const cands: { start: number; end: number; body: string }[] = [];
  const fence = /```(?:json|actions?)?\s*([\s\S]*?)```/gi;
  for (let m; (m = fence.exec(src));) cands.push({ start: m.index, end: m.index + m[0].length, body: m[1] });
  if (!cands.length) {
    const i = src.search(/\{\s*"(?:actions|tools|calls|report)"/);
    if (i >= 0) cands.push({ start: i, end: src.length, body: src.slice(i) });
  }
  for (const c of cands.reverse()) {
    let j: any = null;
    const body = c.body.trim();
    try { j = JSON.parse(body); } catch {
      const a = body.indexOf('{'), b = body.lastIndexOf('}');
      if (a >= 0 && b > a) { try { j = JSON.parse(body.slice(a, b + 1)); } catch { j = null; } }
    }
    if (!j || typeof j !== 'object') continue;
    const list: any[] = Array.isArray(j) ? j : [...(j.actions ?? []), ...(j.tools ?? []), ...(j.calls ?? [])];
    if (!Array.isArray(j) && j.report && typeof j.report === 'object') list.push({ name: 'write_report', args: j.report });
    if (!Array.isArray(j) && !('actions' in j || 'tools' in j || 'calls' in j || 'report' in j)) continue;
    const calls = list.map(normCall).filter((x): x is ToolCall => !!x);
    return { text: (src.slice(0, c.start) + src.slice(c.end)).trim(), calls };
  }
  return { text: src.trim(), calls: [] };
}

/** CLI 모델용: 블록의 화면 동작만 실행(데이터 조회는 MCP로 이미 함) */
export function applyPageCalls(calls: ToolCall[], out: ChatOut) {
  for (const c of calls) if (PAGE_TOOLS.has(c.name)) { out.tools.push(c.name); runTool(c.name, c.args, out); }
}

export const ACTION_BLOCK_GUIDE = [
  '화면 조작이 필요하면 답의 맨 끝에 아래 형식의 JSON 블록 하나만 붙인다(필요 없으면 생략).',
  '```json',
  '{"actions":[{"type":"set_mode","system":"자주포"},{"type":"focus_country","country":"폴란드"},{"type":"toggle_map_mode","flat":true},{"type":"report","country":"폴란드","system":"자주포"}]}',
  '```',
  'type: set_mode(system: 일반|자주포|장갑차|대공미사일|다연장로켓|호위함|재래식 잠수함), focus_country(country), toggle_map_mode(flat 생략 가능), report(country, system 생략 가능; 보고서는 화면에 자동 표시되므로 본문엔 한 문장만).',
].join('\n');
