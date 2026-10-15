import { TOOL_IMPLS, writeReport } from '../shared/tools';
import { resolveCountry, resolveSystem, isGeneral, seed } from '../shared/data';

export interface Env { GOOGLE_API_KEY?: string; GEMMA_MODEL?: string; GOOGLE_BASE_URL?: string }
export interface ChatIn { messages: { role: 'user' | 'model'; text: string }[]; state?: { mode?: string | null; flat?: boolean; focus?: string | null } }
export interface ChatOut { reply: string; actions: Record<string, unknown>[]; reports: string[]; tools: string[]; nokey?: boolean; error?: string; detail?: string }

const S = (description: string) => ({ type: 'STRING', description });
export const FUNCTION_DECLARATIONS = [
  { name: 'set_mode', description: '히트맵 모드 변경', parameters: { type: 'OBJECT', properties: { system: S('일반|자주포|장갑차|대공미사일|다연장로켓|호위함|재래식 잠수함') }, required: ['system'] } },
  { name: 'toggle_map_mode', description: '3D 지구본과 2D 지도 전환', parameters: { type: 'OBJECT', properties: { flat: { type: 'BOOLEAN', description: 'true=2D 지도, false=3D 지구본, 생략=전환' } } } },
  { name: 'focus_country', description: '카메라를 국가로 이동', parameters: { type: 'OBJECT', properties: { country: S('국가명') }, required: ['country'] } },
  { name: 'get_forecast', description: '국가·체계의 예상 교체 시기·수량·금액(예측)과 계산 과정', parameters: { type: 'OBJECT', properties: { country: S('국가명'), system: S('체계(생략 시 전체)') }, required: ['country'] } },
  { name: 'list_forecasts', description: '체계별 임박 순 예측 목록', parameters: { type: 'OBJECT', properties: { system: S('체계'), limit: { type: 'INTEGER' } } } },
  { name: 'search_programs', description: '보유 장비·최근 계약·사업 계획 조회', parameters: { type: 'OBJECT', properties: { country: S('국가명'), system: S('체계') } } },
  { name: 'get_lifespan', description: '설계 수명과 모델별 교체 시점', parameters: { type: 'OBJECT', properties: { system: S('체계'), model: S('모델명 일부') } } },
  { name: 'search_mro', description: '정비·성능개량·수명연장 기록', parameters: { type: 'OBJECT', properties: { country: S('국가명'), model: S('모델명 일부') } } },
  { name: 'write_report', description: '국가 보고서 작성(화면에 자동 표시)', parameters: { type: 'OBJECT', properties: { country: S('국가명'), system: S('체계(생략 시 전체)') }, required: ['country'] } },
];

function systemPrompt(st: ChatIn['state']) {
  const countries = Object.values(seed.countries).map(c => c.ko).join(', ');
  return [
    '너는 「무기조달사업예상」 웹앱의 한국어 도우미다. 지구본 히트맵으로 각국 무기 교체 사업 시기·규모를 예측한다.',
    '규칙: 수치는 도구 결과만 쓰고 지어내지 않는다. 예측은 "예측", 추정값은 "추정"으로 밝힌다. 답은 짧게(최대 5줄).',
    '화면 변경 요청은 set_mode/toggle_map_mode/focus_country. 특정 국가 질문엔 focus_country도 호출. 보고서 요청은 write_report 후 한 문장만 답한다.',
    `데이터 국가: ${countries}.`,
    `현재 화면: 모드=${st?.mode ? seed.systems[st.mode as keyof typeof seed.systems]?.ko ?? st.mode : '일반'}, 지도=${st?.flat ? '2D' : '3D'}, 선택=${st?.focus ?? '없음'}.`,
  ].join('\n');
}

const trim = (v: unknown, n = 3500) => { const s = JSON.stringify(v); return s.length > n ? JSON.parse(JSON.stringify({ truncated: true, text: s.slice(0, n) })) : v; };

async function post(url: string, key: string, body: unknown): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < 3; i++) { // 최초 1회 + 5xx 재시도 2회
    const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) };
    try { (init as any).signal = AbortSignal.timeout(60000); } catch { /* 구형 런타임 */ }
    last = await fetch(url, init);
    if (last.status < 500) return last;
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  return last!;
}

export async function chat(input: ChatIn, env: Env): Promise<ChatOut> {
  const out: ChatOut = { reply: '', actions: [], reports: [], tools: [] };
  const key = env.GOOGLE_API_KEY?.trim();
  if (!key) return { ...out, nokey: true, reply: 'AI 키가 설정되지 않았습니다. !help' };
  const model = env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
  const base = (env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${model}:generateContent`;
  const sys = systemPrompt(input.state);
  const msgs = (input.messages ?? []).slice(-7).filter(m => m && m.text);
  const contents: any[] = msgs.map(m => ({ role: m.role === 'model' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 1500) }] }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') return { ...out, error: '메시지 없음' };
  let fold = false;

  const body = (withTools: boolean) => {
    const c = fold ? [{ role: 'user', parts: [{ text: sys }] }, { role: 'model', parts: [{ text: '알겠습니다.' }] }, ...contents] : contents;
    const b: any = { contents: c, generationConfig: { temperature: 0.3, maxOutputTokens: 1200 } };
    if (!fold) b.systemInstruction = { parts: [{ text: sys }] };
    if (withTools) { b.tools = [{ functionDeclarations: FUNCTION_DECLARATIONS }]; b.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; }
    return b;
  };

  for (let round = 0; round <= 3; round++) {
    const withTools = round < 3;
    let r = await post(url, key, body(withTools));
    if (r.status === 400 && !fold) { fold = true; r = await post(url, key, body(withTools)); }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const msg = r.status === 429 ? '요청 한도 초과. 잠시 후 다시 시도' : r.status === 403 || r.status === 401 || /API key|API_KEY/i.test(t) ? 'API 키 오류' : r.status === 404 ? '모델을 찾을 수 없음' : `AI 오류 ${r.status}`;
      return { ...out, error: msg, detail: t.slice(0, 300) } as ChatOut;
    }
    const j: any = await r.json();
    const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter(p => p.functionCall);
    const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
    if (!calls.length) { out.reply = text || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
    contents.push({ role: 'model', parts: parts.filter(p => !p.thought || p.thoughtSignature) });
    const responses: any[] = [];
    for (const p of calls) {
      const name: string = p.functionCall.name; const args = p.functionCall.args ?? {};
      out.tools.push(name);
      responses.push({ functionResponse: { name, response: { result: trim(runTool(name, args, out)) } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  out.reply = out.reply || '완료';
  return out;
}

export function runTool(name: string, args: Record<string, any>, out: ChatOut): unknown {
  switch (name) {
    case 'set_mode': {
      const s = isGeneral(args.system) ? null : resolveSystem(args.system);
      if (!s && !isGeneral(args.system)) return { ok: false, error: '체계 이름 확인' };
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
