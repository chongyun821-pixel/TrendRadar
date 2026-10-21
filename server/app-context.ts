import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from '../shared/app-context';
import { resolveCountry, resolveSystem, isGeneral } from '../shared/data';
import { SYSTEM_KEYS } from '../shared/types';
import { execution } from './execution';
import { now, type Repository } from './store';
import type { ToolDef } from './agent';

const system = z.enum(SYSTEM_KEYS);
export const appContextSchema = z.object({
  screenId: z.string().uuid(), version: z.number().int().nonnegative(), conversationId: z.string().uuid().nullable(),
  model: z.enum(['grok', 'codex', 'gpt', 'nemotron']), activeView: z.enum(['map', 'report']),
  mode: system.nullable(), flat: z.boolean(), focus: z.string().regex(/^[A-Z]{3}$/).nullable(),
  filters: z.object({ system: system.nullable() }).strict(),
  report: z.object({ id: z.string().uuid(), country: z.string().nullable(), system: system.nullable(), kind: z.literal('country-analysis'), basisDate: z.string(), dataVersion: z.number().int() }).nullable(),
  dataVersion: z.number().int().nonnegative(),
}).strict();
const S = (description: string) => ({ type: 'string' as const, description });
const target = { screenId: S('대상 화면 ID. 생략하면 실행을 시작한 화면') };
export const APP_DEFS: ToolDef[] = [
  { name: 'get_app_context', description: '요청 당시 화면과 최신 화면의 필터, 선택 국가, 열린 보고서를 조회한다', properties: target },
  { name: 'get_map_state', description: '대상 화면의 지도 상태를 조회한다', properties: target },
  { name: 'set_map_state', description: '지도 필터와 선택 국가 및 2D/3D 보기를 변경하도록 요청한다. 반환은 접수이며 적용 결과는 명령 ID로 조회한다', properties: { ...target, payload: S('JSON: system?(일반은 null), country?(선택 해제는 null), flat?'), expectedVersion: { type: 'integer' } }, required: ['payload'] },
  { name: 'get_app_command', description: '화면 제어 명령의 접수, 적용, 충돌 또는 실패 결과를 조회한다', properties: { commandId: S('명령 ID') }, required: ['commandId'] },
  { name: 'list_conversations', description: '저장된 대화 목록을 조회한다', properties: {} },
  { name: 'search_conversations', description: '대화 제목과 전체 메시지를 문자열로 검색한다', properties: { query: S('찾을 문자열') }, required: ['query'] },
  { name: 'read_conversation', description: '지정한 대화의 메시지와 보고서 및 파일을 읽는다', properties: { conversationId: S('생략하면 실행을 시작한 대화'), query: S('메시지 검색어'), offset: { type: 'integer' }, limit: { type: 'integer' } } },
  { name: 'switch_conversation', description: '대상 화면에 표시할 대화를 전환한다. 진행 중 작업의 저장 대상은 유지한다', properties: { ...target, conversationId: S('전환할 대화 ID'), expectedVersion: { type: 'integer' } }, required: ['conversationId'] },
  { name: 'create_conversation', description: '새 대화를 만든다. 화면 전환은 switch_conversation으로 요청한다', properties: { title: S('대화 제목') } },
  { name: 'delete_conversation', description: '대화를 삭제하고 원문 근거와 보고서 및 파일은 보존한다. 현재 실행 중인 대화는 중지 후 삭제한다', properties: { conversationId: S('삭제할 대화 ID') }, required: ['conversationId'] },
  { name: 'set_chat_model', description: '지정한 화면의 다음 요청부터 사용할 모델을 변경한다', properties: { ...target, model: S('codex, grok, gpt, nemotron'), expectedVersion: { type: 'integer' } }, required: ['model'] },
  { name: 'get_run_status', description: '실행 상태와 오류를 조회한다', properties: { runId: S('생략하면 현재 실행') } },
  { name: 'cancel_run', description: '실행에 중지를 요청한다. 자신의 종료를 기다리지 않는다', properties: { runId: S('생략하면 현재 실행') } },
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
  const expected = expectedVersion ?? ctx.appContext?.version ?? current.state.version;
  if (expected !== current.state.version) throw new Error('화면 버전 충돌: 최신 상태를 확인하세요');
  const commandId = randomUUID();
  await ctx.repo.run('INSERT INTO app_commands VALUES(?,?,?,?,?,?,?,?,?)', commandId, current.state.screenId, ctx.conversationId, ctx.runId, expected, JSON.stringify(data), 'pending', null, now());
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
  const p = z.object({ status: z.enum(['applied', 'conflict', 'failed']), detail: z.string().optional() }).parse(raw);
  const row = await repo.one('SELECT * FROM app_commands WHERE id=? AND screen_id=?', z.string().uuid().parse(id), z.string().uuid().parse(screenId));
  if (!row) throw new Error('화면 명령이 없습니다');
  await repo.run("UPDATE app_commands SET status=?,result=? WHERE id=? AND status='pending'", p.status, JSON.stringify(p), id);
  return { ok: true };
}
export async function appTool(name: string, a: Record<string, any>): Promise<unknown> {
  const ctx = await execution(), repo = ctx.repo;
  switch (name) {
    case 'get_app_context': return { request: ctx.appContext || null, current: await readAppContext(repo, a.screenId || ctx.appContext?.screenId) };
    case 'get_map_state': return readAppContext(repo, a.screenId || ctx.appContext?.screenId);
    case 'set_map_state': {
      const p = z.object({ system: z.string().nullable().optional(), country: z.string().nullable().optional(), flat: z.boolean().optional() }).strict().parse(JSON.parse(a.payload));
      const state: Record<string, unknown> = { ...p };
      if (p.system != null) { const s = resolveSystem(p.system); if (!s && !isGeneral(p.system)) throw new Error('무기체계 확인 필요'); state.system = s; }
      if (p.country != null) { const c = resolveCountry(p.country); if (!c) throw new Error('국가 확인 필요'); state.country = c; }
      return requestAppCommand({ type: 'set_map_state', ...state }, a.screenId, a.expectedVersion);
    }
    case 'get_app_command': return await repo.one('SELECT id,status,result FROM app_commands WHERE id=? AND conversation_id=?', a.commandId, ctx.conversationId) || { error: '명령 없음' };
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
    case 'switch_conversation': await repo.conversation(a.conversationId); return requestAppCommand({ type: name, conversationId: a.conversationId }, a.screenId, a.expectedVersion);
    case 'delete_conversation': {
      if (a.conversationId === ctx.conversationId) throw new Error('현재 실행 중인 대화는 응답 중지 후 앱에서 삭제하세요');
      if (await repo.one("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", a.conversationId)) throw new Error('진행 중 작업을 먼저 중지하세요');
      await repo.deleteConversation(a.conversationId); return { ok: true, evidencePreserved: true };
    }
    case 'set_chat_model': {
      const model = z.enum(['grok', 'codex', 'gpt', 'nemotron']).parse(a.model);
      const { listModels } = await import('./models');
      if (!(await listModels(ctx.env)).some(m => m.id === model && m.available)) throw new Error('사용할 수 없는 모델');
      return requestAppCommand({ type: name, model }, a.screenId, a.expectedVersion);
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
