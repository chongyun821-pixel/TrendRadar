import type { MapDisplayPatch, MapZoom } from '../shared/map-display';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../shared/app-context';
import { resolveCountry, resolveSystem, isGeneral } from '../shared/data';
import { SYSTEM_KEYS, type SystemKey } from '../shared/types';
import { execution, executions } from './execution';
import { now, type Repository } from './store';
import type { ToolDef, ChatOut } from './agent';
import { modelChoiceSchema, modelOptionsSchema } from './model-choice';

const system = z.enum(SYSTEM_KEYS);
const iso = z.string().regex(/^[A-Z]{3}$/);
export const appContextSchema = z.object({
  screenId: z.string().uuid(), version: z.number().int().nonnegative(), conversationId: z.string().uuid().nullable(),
  model: z.enum(['grok', 'codex', 'gpt', 'nemotron']), modelOptions: modelOptionsSchema.optional(), activeView: z.enum(['map', 'report']),
  mode: system.nullable(), flat: z.boolean(), focus: z.string().regex(/^[A-Z]{3}$/).nullable(),
  filters: z.object({ system: system.nullable() }).strict(),
  display: z.object({ hidden: z.array(iso), only: z.array(iso).nullable(), highlight: z.array(iso), hatch: z.boolean(), bars: z.boolean(), legend: z.boolean() }).strict().optional(),
  report: z.object({ id: z.string().uuid(), country: z.string().nullable(), system: system.nullable(), kind: z.literal('country-analysis'), basisDate: z.string(), dataVersion: z.number().int() }).nullable(),
  dataVersion: z.number().int().nonnegative(),
  /** 탭이 백그라운드면 true(브라우저가 숨김 전환 때 알린다). 버전에는 넣지 않는다 */
  hidden: z.boolean().optional(),
}).strict();
const S = (description: string) => ({ type: 'string' as const, description });
const target = { screenId: S('대상 화면 ID. 생략하면 실행을 시작한 화면') };
/** 화면 도구(모델에게 먼저 보인다). set_map_state 하나로 국가·체계·2D/3D를 맞춘다 */
export const SCREEN_DEFS: ToolDef[] = [
  { name: 'set_map_state', description: '지도 화면을 국가·무기체계·2D/3D·확대 단계와 국가 숨김·특정 국가만 표시·강조·빗금·막대·범례 표시로 맞춘다(한 번에, 사용자가 보던 화면과 무관하게 적용). 브라우저 적용 결과(applied·conflict·inactive·failed)를 바로 돌려준다', properties: { country: S('국가 이름·ISO 코드·별칭(예: 폴란드, POL). 선택 해제는 "해제"'), system: S('자주포·IFV·대공미사일·다연장로켓·호위함·재래식 잠수함 또는 일반'), flat: { type: 'boolean', description: 'true=2D 지도, false=3D 지구본' },
    zoom: S('확대·축소: in(확대)·out(축소)·reset(기본 거리) 또는 1(가장 멀리)~10(가장 가까이) 단계. country와 함께 주면 그 국가로 이동한 뒤 적용'),
    hide: S('색·빗금·막대를 숨길 국가 목록(쉼표 구분, 예: "중국, 러시아"). 지정한 목록으로 바꾸며 "해제"는 숨김 없음'),
    only: S('이 국가들만 표시하고 나머지는 숨긴다(쉼표 구분). "해제"는 전체 표시'),
    highlight: S('강조할 국가(쉼표 구분). 나머지 국가는 어둡게 한다. "해제"는 강조 없음'),
    hatch: { type: 'boolean', description: 'false=인접국 참고 빗금 숨김, true=다시 표시' },
    bars: { type: 'boolean', description: 'false=예상 금액 막대(2D는 원) 숨김, true=다시 표시' },
    legend: { type: 'boolean', description: 'false=범례 숨김, true=다시 표시' },
    resetDisplay: { type: 'boolean', description: 'true=숨김·특정 국가만·강조·빗금·막대·범례 조정을 모두 기본으로 되돌린다(다른 항목은 그 뒤에 적용)' },
    ...target, expectedVersion: { type: 'integer', description: '생략 권장' } } },
  { name: 'get_app_context', description: '요청 당시와 지금의 화면 상태(모드·선택 국가·열린 보고서·탭 표시 여부)', properties: target },
];
/** 예전 이름. 모델에게는 보이지 않고 액션 블록·기존 호출만 받는다 */
export const LEGACY_SCREEN_TOOLS = ['set_mode', 'focus_country', 'toggle_map_mode', 'get_map_state'] as const;
export const APP_DEFS: ToolDef[] = [
  { name: 'list_conversations', description: '저장된 대화 목록을 조회한다', properties: {} },
  { name: 'search_conversations', description: '대화 제목과 전체 메시지를 문자열로 검색한다', properties: { query: S('찾을 문자열') }, required: ['query'] },
  { name: 'read_conversation', description: '지정한 대화의 메시지와 보고서 및 파일을 읽는다', properties: { conversationId: S('생략하면 실행을 시작한 대화'), query: S('메시지 검색어'), offset: { type: 'integer' }, limit: { type: 'integer' } } },
  { name: 'switch_conversation', description: '대상 화면에 표시할 대화를 전환한다. 진행 중 작업의 저장 대상은 유지한다', properties: { ...target, conversationId: S('전환할 대화 ID'), expectedVersion: { type: 'integer' } }, required: ['conversationId'] },
  { name: 'create_conversation', description: '새 대화를 만든다. 화면 전환은 switch_conversation으로 요청한다', properties: { title: S('대화 제목') } },
  { name: 'delete_conversation', description: '대화를 삭제하고 원문 근거와 보고서 및 파일은 보존한다. 현재 실행 중인 대화는 중지 후 삭제한다', properties: { conversationId: S('삭제할 대화 ID') }, required: ['conversationId'] },
  { name: 'set_chat_model', description: '지정한 화면의 다음 요청부터 사용할 모델을 변경한다', properties: { ...target, model: S('codex, grok, gpt, nemotron'), cliModel: S('코덱스: gpt-6.1-sol·gpt-6-luna·gpt-6-astra, 그록 빌드: grok-4.7·grok-4.7-build-fast·grok-4.6·grok-4.5'), effort: S('추론 강도(코덱스 low~max·ultra, 그록 빌드 low~xhigh)'), expectedVersion: { type: 'integer' } }, required: ['model'] },
  { name: 'get_run_status', description: '실행 상태와 오류를 조회한다', properties: { runId: S('생략하면 현재 실행') } },
  { name: 'cancel_run', description: '실행에 중지를 요청한다. 자신의 종료를 기다리지 않는다', properties: { runId: S('생략하면 현재 실행') } },
  { name: 'get_app_command', description: '화면 도구가 pending을 돌려준 경우에만 그 commandId의 적용 결과를 최대 3초 다시 기다린다', properties: { commandId: S('명령 ID') }, required: ['commandId'] },
];

export async function saveAppContext(repo: Repository, raw: unknown) {
  const state = appContextSchema.parse(raw);
  if (state.filters.system !== state.mode) throw new Error('지도 필터와 모드가 일치하지 않습니다');
  if (state.activeView === 'report' && !state.report) throw new Error('활성 보고서 정보가 없습니다');
  if (state.conversationId) await repo.conversation(state.conversationId);
  if (state.report) {
    const report = await repo.one('SELECT * FROM reports WHERE id=? AND conversation_id=?', state.report.id, state.conversationId);
    if (!report || report.data_version !== state.report.dataVersion || report.basis_date !== state.report.basisDate) throw new Error('보고서 기준 정보가 일치하지 않습니다');
    const info = reportTarget(report.markdown);
    state.report = { ...state.report, ...info };
  }
  await repo.run('INSERT INTO app_contexts VALUES(?,?,?,?,?) ON CONFLICT(screen_id) DO UPDATE SET conversation_id=excluded.conversation_id,version=excluded.version,state=excluded.state,updated_at=excluded.updated_at WHERE excluded.version>=app_contexts.version', state.screenId, state.conversationId, state.version, JSON.stringify(state), now());
  return state;
}
export function reportTarget(markdown: string) {
  const headings = markdown.split('\n').filter(line => line.startsWith('## '));
  const countries = [...new Set(headings.map(h => resolveCountry(h)).filter(Boolean))];
  const systems = [...new Set(headings.map(h => resolveSystem(h)).filter(Boolean))];
  return { country: countries.length === 1 ? countries[0]! : null, system: systems.length === 1 ? systems[0]! : null };
}
export async function readAppContext(repo: Repository, screenId?: string) {
  if (!screenId) return { available: false as const, reason: '연결된 앱 화면이 없습니다' };
  const row = await repo.one('SELECT * FROM app_contexts WHERE screen_id=?', z.string().uuid().parse(screenId));
  if (!row) return { available: false as const, reason: '화면 상태가 없습니다' };
  return { available: true as const, stale: Date.now() - Date.parse(row.updated_at) > 30_000, observedAt: row.updated_at, state: JSON.parse(row.state) as AppContext };
}
export async function requestAppCommand(data: Record<string, unknown>, screenId?: string, expectedVersion?: number) {
  const ctx = await execution();
  const current = await readAppContext(ctx.repo, screenId || ctx.appContext?.screenId);
  if (!current.available || current.stale) throw new Error('활성 앱 화면이 없습니다. 앱에서 다시 요청하세요');
  if (current.state.conversationId !== ctx.conversationId) throw new Error('화면의 대화가 변경되었습니다');
  // 챗봇의 화면 명령은 사용자가 그사이 화면을 바꿨더라도 항상 적용한다(같은 대화의 화면에 한한다)
  const expected = current.state.version;
  const commandId = randomUUID();
  const latest = await ctx.repo.one('SELECT created_at FROM app_commands WHERE screen_id=? ORDER BY created_at DESC LIMIT 1', current.state.screenId);
  const createdAt = new Date(Math.max(Date.now(), latest ? Date.parse(latest.created_at) + 1 : 0)).toISOString();
  await ctx.repo.run('INSERT INTO app_commands VALUES(?,?,?,?,?,?,?,?,?)', commandId, current.state.screenId, ctx.conversationId, ctx.runId, expected, JSON.stringify({ ...data, chain: expectedVersion === undefined }), 'pending', null, createdAt);
  return { ok: true, status: 'pending', commandId, nextStep: 'get_app_command로 실제 화면 적용 결과를 확인하세요' };
}
export async function pendingCommands(repo: Repository, screenId: string) {
  const rows = await repo.all("SELECT * FROM app_commands WHERE screen_id=? AND status='pending' ORDER BY created_at,id", z.string().uuid().parse(screenId));
  const result = [];
  for (const row of rows) {
    const run = await repo.one('SELECT status FROM runs WHERE id=?', row.run_id);
    if (!run || !['running', 'completed'].includes(run.status)) {
      await repo.run("UPDATE app_commands SET status='cancelled' WHERE id=? AND status='pending'", row.id);
    } else result.push({ ...row, data: JSON.parse(row.data) });
  }
  return result;
}
export async function acknowledgeCommand(repo: Repository, screenId: string, id: string, raw: unknown) {
  const p = z.object({ status: z.enum(['applied', 'conflict', 'failed']), detail: z.string().optional(), version: z.number().int().nonnegative().optional(), state: appContextSchema.optional() }).parse(raw);
  const row = await repo.one('SELECT * FROM app_commands WHERE id=? AND screen_id=?', z.string().uuid().parse(id), z.string().uuid().parse(screenId));
  if (!row) throw new Error('화면 명령이 없습니다');
  if (p.state && (p.state.screenId !== screenId || p.version !== undefined && p.state.version !== p.version)) throw new Error('화면 명령의 적용 버전이 일치하지 않습니다');
  const { state, ...result } = p;
  // 화면 버전만 먼저 공개되면 다음 도구가 아직 확인되지 않은 변경으로 오인할 수 있다.
  await repo.transaction(async () => {
    if (state) await saveAppContext(repo, state);
    await repo.run("UPDATE app_commands SET status=?,result=? WHERE id=? AND status='pending'", p.status, JSON.stringify(result), id);
  });
  return { ok: true };
}
export async function appTool(name: string, a: Record<string, any>): Promise<unknown> {
  const ctx = await execution(), repo = ctx.repo;
  switch (name) {
    case 'get_app_context': return { request: ctx.appContext || null, current: await readAppContext(repo, a.screenId || ctx.appContext?.screenId) };
    case 'get_map_state': return readAppContext(repo, a.screenId || ctx.appContext?.screenId);
    case 'get_app_command': return waitCommand(z.string().uuid().parse(a.commandId), 3000);
    case 'list_conversations': return repo.all('SELECT * FROM conversations ORDER BY updated_at DESC');
    case 'search_conversations': {
      const query = z.string().min(1).parse(a.query);
      const rows = await repo.all('SELECT * FROM conversations ORDER BY updated_at DESC');
      const messages = await repo.all('SELECT * FROM messages ORDER BY rowid');
      return rows.filter(r => r.title.includes(query) || messages.some(m => m.conversation_id === r.id && (m.text.includes(query) || m.payload.includes(query))));
    }
    case 'read_conversation': {
      const conversation = await repo.conversation(a.conversationId || ctx.conversationId);
      const msgs = conversation.messages.filter((m: any) => !a.query || m.text.includes(a.query) || JSON.stringify(m.reports || []).includes(a.query));
      const offset = z.number().int().nonnegative().parse(a.offset ?? 0), limit = z.number().int().positive().parse(a.limit ?? Math.max(1, msgs.length));
      return { ...conversation, messages: msgs.slice(offset, offset + limit), total: msgs.length };
    }
    case 'create_conversation': { const c = await repo.createConversation(a.title || '새 대화'); return { id: c.id, title: c.title }; }
    case 'switch_conversation': await repo.conversation(a.conversationId); return screenCommand({ type: name, conversationId: a.conversationId }, a.screenId, a.expectedVersion);
    case 'delete_conversation': {
      if (a.conversationId === ctx.conversationId) throw new Error('현재 실행 중인 대화는 응답 중지 후 앱에서 삭제하세요');
      if (await repo.one("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", a.conversationId)) throw new Error('진행 중 작업을 먼저 중지하세요');
      await repo.deleteConversation(a.conversationId); return { ok: true, evidencePreserved: true };
    }
    case 'set_chat_model': {
      const parsed = modelChoiceSchema.safeParse({ provider: a.model, ...(a.cliModel ? { model: a.cliModel } : {}), ...(a.effort ? { effort: a.effort } : {}) });
      if (!parsed.success) throw new Error(parsed.error.issues.map(i => i.message).join('; '));
      const { provider: model, model: cliModel, effort } = parsed.data;
      const { listModels } = await import('./models');
      if (!(await listModels(ctx.env)).some(m => m.id === model && m.available)) throw new Error('사용할 수 없는 모델');
      return screenCommand({ type: name, model, ...(cliModel ? { cliModel } : {}), ...(effort ? { effort } : {}) }, a.screenId, a.expectedVersion);
    }
    case 'get_run_status': return repo.one('SELECT * FROM runs WHERE id=? AND conversation_id=?', a.runId || ctx.runId, ctx.conversationId);
    case 'cancel_run': {
      const id = a.runId || ctx.runId;
      const run = await repo.one('SELECT id,status FROM runs WHERE id=? AND conversation_id=?', id, ctx.conversationId);
      if (!run) throw new Error('이 대화의 실행이 아닙니다');
      if (run.status === 'queued') {
        await repo.run("UPDATE runs SET status='cancelled',error=?,ended_at=? WHERE id=? AND status='queued'", '대기 메시지를 취소했습니다', now(), id);
        return { ok: true, status: 'cancelled' };
      }
      if (!['running', 'stopping'].includes(run.status)) return { ok: true, unchanged: true, status: run.status };
      await repo.run("UPDATE runs SET status='stopping' WHERE id=? AND status='running'", id);
      return { ok: true, status: 'stopping' };
    }
    default: throw new Error('알 수 없는 앱 도구');
  }
}

/* ───────── 화면 명령 결과: 브라우저 적용을 잠시 기다려 최종 상태를 돌려준다 ───────── */
/** 적용 대기 시간. 테스트는 줄일 수 있다 */
export const screenSettings = { waitMs: 3000 };
const MESSAGES = {
  conflict: '화면이 다른 대화로 바뀌어 적용하지 않았다. 반영하지 못한 내용을 답에 한 줄로 알린다',
  hidden: '앱 탭이 백그라운드에 있어 아직 적용되지 않았다. 탭을 다시 열면 자동으로 적용된다고 사용자에게 알린다',
  closed: '앱 화면이 닫혀 있거나 응답하지 않아 화면을 바꾸지 못했다. 앱 화면을 열고 다시 요청해 달라고 사용자에게 알린다',
  otherConversation: '사용자가 화면에서 다른 대화를 보고 있어 바꾸지 않았다. 반영하지 못한 내용을 사용자에게 알린다',
  pending: '브라우저가 아직 적용하지 않았다. 필요하면 get_app_command(commandId)로 한 번 더 확인한다',
};
type ScreenResult = { ok: boolean; status: 'applied' | 'conflict' | 'failed' | 'cancelled' | 'inactive' | 'pending'; commandId?: string; detail?: string; message?: string; error?: string; version?: number; result?: unknown };
const fail = (status: ScreenResult['status'], message: string, extra: Partial<ScreenResult> = {}): ScreenResult => ({ ok: false, status, message, error: message, ...extra });

/** 명령을 접수하고 적용 결과(applied·conflict·failed·inactive, 시간 안에 못 받으면 pending)를 돌려준다. 앱 화면이 없거나 다른 대화면 접수하지 않는다 */
export async function screenCommand(data: Record<string, unknown>, screenId?: string, expectedVersion?: number): Promise<ScreenResult> {
  const ctx = await execution();
  const current = await readAppContext(ctx.repo, screenId || ctx.appContext?.screenId);
  if (!current.available || current.stale) return fail('inactive', MESSAGES.closed);
  if (current.state.conversationId !== ctx.conversationId) return fail('conflict', MESSAGES.otherConversation);
  const queued = await requestAppCommand(data, screenId, expectedVersion);
  return waitCommand(queued.commandId);
}
export async function waitCommand(commandId: string, ms = screenSettings.waitMs): Promise<ScreenResult> {
  const ctx = await execution(), deadline = Date.now() + ms;
  for (;;) {
    ctx.signal.throwIfAborted();
    const row = await ctx.repo.one('SELECT id,screen_id,status,result FROM app_commands WHERE id=? AND conversation_id=?', commandId, ctx.conversationId);
    if (!row) return fail('failed', '화면 명령이 없습니다');
    const result = row.result ? JSON.parse(row.result) : undefined;
    if (row.status === 'applied') return { ok: true, status: 'applied', commandId, ...(result?.version !== undefined ? { version: result.version } : {}), ...(result ? { result } : {}) };
    if (row.status === 'conflict') return fail('conflict', MESSAGES.conflict, { commandId, detail: result?.detail, result });
    if (row.status === 'failed') return fail('failed', `화면 적용 실패: ${result?.detail || '원인 미상'}. 사용자에게 알린다`, { commandId, detail: result?.detail, result });
    if (row.status === 'cancelled') return fail('cancelled', '실행이 끝나 화면 명령을 취소했다', { commandId });
    if (Date.now() >= deadline) {
      const screen = await readAppContext(ctx.repo, row.screen_id);
      if (!screen.available || screen.stale) return fail('inactive', MESSAGES.closed, { commandId });
      if (screen.state.hidden) return fail('inactive', MESSAGES.hidden, { commandId });
      return { ok: false, status: 'pending', commandId, message: MESSAGES.pending };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

const CLEAR = /^(해제|없음|선택\s*해제|none|null|clear)$/i;
/** 국가: 데이터 국가 이름·별칭 → ISO 3자리 코드 → 세계 지도 국가 이름 */
async function mapCountry(raw: string): Promise<string | null> {
  const known = resolveCountry(raw);
  if (known) return known;
  if (/^[A-Za-z]{3}$/.test(raw.trim())) return raw.trim().toUpperCase();
  const { countryId } = await import('./ingest/common');
  return countryId(raw);
}
/** set_map_state 입력(일반 필드, 예전 payload JSON, 예전 도구 이름)을 { country?, system?, flat?, zoom?, display? }로 정리한다 */
export async function mapTarget(name: string, a: Record<string, any>, currentFlat?: () => Promise<boolean | undefined>) {
  let raw: Record<string, unknown> = name === 'set_mode' ? { system: a.system ?? null } : name === 'focus_country' ? { country: a.country } : name === 'toggle_map_mode' ? { flat: a.flat } : { country: a.country, system: a.system, flat: a.flat, zoom: a.zoom, hide: a.hide, only: a.only, highlight: a.highlight, hatch: a.hatch, bars: a.bars, legend: a.legend, resetDisplay: a.resetDisplay };
  if (name === 'set_map_state' && typeof a.payload === 'string' && a.payload.trim()) raw = { ...raw, ...z.record(z.unknown()).parse(JSON.parse(a.payload)) };
  const target: { country?: string | null; system?: SystemKey | null; flat?: boolean; zoom?: MapZoom; display?: MapDisplayPatch } = {};
  if (raw.country === null || (typeof raw.country === 'string' && CLEAR.test(raw.country.trim()))) target.country = null;
  else if (raw.country != null && String(raw.country).trim()) {
    const c = await mapCountry(String(raw.country));
    if (!c) throw new Error(`국가 확인 필요: ${raw.country}`);
    target.country = c;
  }
  if (raw.system === null || (typeof raw.system === 'string' && isGeneral(raw.system))) target.system = null;
  else if (raw.system != null && String(raw.system).trim()) {
    const s = resolveSystem(String(raw.system));
    if (!s) throw new Error(`무기체계 확인 필요: ${raw.system} (자주포·IFV·대공미사일·다연장로켓·호위함·재래식 잠수함·일반)`);
    target.system = s;
  }
  const flat = typeof raw.flat === 'string' ? (/^(2d|true|flat|평면)$/i.test(raw.flat) ? true : /^(3d|false|globe|지구본)$/i.test(raw.flat) ? false : undefined) : raw.flat;
  if (typeof flat === 'boolean') target.flat = flat;
  if (name === 'set_map_state') {
    const zoom = parseZoom(raw.zoom);
    if (zoom !== undefined) target.zoom = zoom;
    const display: MapDisplayPatch = {};
    if (flag(raw.resetDisplay) === true) display.reset = true;
    const hidden = await countryList(raw.hide), only = await countryList(raw.only), highlight = await countryList(raw.highlight);
    if (hidden !== undefined) display.hidden = hidden ?? [];
    if (only !== undefined) display.only = only;
    if (highlight !== undefined) display.highlight = highlight ?? [];
    for (const key of ['hatch', 'bars', 'legend'] as const) { const v = flag(raw[key]); if (v !== undefined) display[key] = v; }
    if (Object.keys(display).length) target.display = display;
  }
  else if (name === 'toggle_map_mode') { const now = await currentFlat?.(); if (now !== undefined) target.flat = !now; }
  return target;
}
const flag = (v: unknown) => typeof v === 'boolean' ? v : typeof v === 'string' ? (/^(true|on|켜기|표시|보이기|1)$/i.test(v.trim()) ? true : /^(false|off|끄기|숨김|숨기기|0)$/i.test(v.trim()) ? false : undefined) : undefined;
function parseZoom(v: unknown): MapZoom | undefined {
  if (v == null || v === '') return undefined;
  const t = String(v).trim();
  if (/^(in|\+|확대|가까이)$/i.test(t)) return 'in';
  if (/^(out|-|축소|멀리)$/i.test(t)) return 'out';
  if (/^(reset|기본|초기화|원래대로)$/i.test(t)) return 'reset';
  const n = Number(t);
  if (Number.isFinite(n) && n >= 1 && n <= 10) return n;
  throw new Error(`확대 값 확인 필요: ${t} (in·out·reset 또는 1~10)`);
}
/** 쉼표로 구분한 국가 목록. 생략이면 undefined, "해제"면 null */
async function countryList(v: unknown): Promise<string[] | null | undefined> {
  if (v == null) return undefined;
  const items = Array.isArray(v) ? v.map(String) : String(v).split(/[,，、·;\n]+/);
  const names = items.map(x => x.trim()).filter(Boolean);
  if (!names.length || (names.length === 1 && CLEAR.test(names[0]))) return null;
  const ids: string[] = [];
  for (const n of names) { const c = await mapCountry(n); if (!c) throw new Error(`국가 확인 필요: ${n}`); if (!ids.includes(c)) ids.push(c); }
  return ids;
}
/** 지도 도구: 앱 화면이 있으면 브라우저 명령으로 보내고 결과를 기다린다. 화면 없이 호출되면 답과 함께 적용할 동작으로 남긴다 */
export async function mapTool(name: string, a: Record<string, any>, out: ChatOut) {
  const ctx = executions.getStore();
  let target: Awaited<ReturnType<typeof mapTarget>>;
  try {
    await ctx?.repo.data(); // 국가·체계 이름 해석은 적재된 조달 데이터를 쓴다
    target = await mapTarget(name, a, async () => {
      if (!ctx?.appContext) return undefined;
      const current = await readAppContext(ctx.repo, ctx.appContext.screenId);
      return current.available ? current.state.flat : ctx.appContext.flat;
    });
  } catch (error) { return fail('failed', error instanceof Error ? error.message : String(error)); }
  if (name === 'toggle_map_mode' && !('flat' in target) && !ctx?.appContext) { out.actions.push({ type: 'toggle_map_mode' }); return { ok: true, status: 'queued', message: '답과 함께 화면에 적용된다' }; }
  if (!Object.keys(target).length) return fail('failed', '바꿀 항목이 없습니다. country·system·flat·zoom·hide·only·highlight·hatch·bars·legend·resetDisplay 중 하나 이상을 지정한다');
  if (ctx?.appContext) return screenCommand({ type: 'set_map_state', ...target }, a.screenId, a.expectedVersion);
  if ('system' in target) out.actions.push({ type: 'set_mode', system: target.system });
  if ('flat' in target) out.actions.push({ type: 'toggle_map_mode', flat: target.flat });
  if (target.display) out.actions.push({ type: 'set_display', display: target.display });
  if (target.country) out.actions.push({ type: 'focus_country', country: target.country });
  if (target.zoom != null) out.actions.push({ type: 'zoom', zoom: target.zoom });
  return { ok: true, status: 'queued', message: '답과 함께 화면에 적용된다', ...target };
}
