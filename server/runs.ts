import { randomUUID } from 'node:crypto';
import { executions, execution } from './execution';
import { collectDocuments } from './artifacts';
import { repository, now } from './store';
import { chatWith, DEFAULT_MODEL } from './models';
import { parseModelChoice } from './model-choice';
import type { ChatIn, ChatOut } from './agent';
import type { Env } from './env';
import { runCommand } from '../src/commands';
import { validateAppContext, reportTarget } from './app-context';
import { attachedReports, reportAttachmentText } from './viewed-reports';

const globals = globalThis as typeof globalThis & {
  __radarRuns?: Map<string, { controller: AbortController; done: Promise<void>; finished: Promise<void> }>;
  __radarQueueWorkers?: Map<string, Promise<void>>;
  __radarQueueTimer?: ReturnType<typeof setInterval>;
  __radarQueueEnv?: Map<string, Env>;
};
export const activeRuns = globals.__radarRuns ??= new Map();
const queueWorkers = globals.__radarQueueWorkers ??= new Map();
const queuedEnvs = globals.__radarQueueEnv ??= new Map();
async function queueTransaction<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await repository().transaction(work); }
    catch (error) { if (attempt >= 4 || !(error instanceof Error) || !error.message.includes('데이터 버전 충돌')) throw error; }
  }
}
export async function recoverRuns(env: Env = {}) {
  const repo = repository();
  await repo.data();
  for (const run of await repo.all("SELECT id,owner_pid,model FROM runs WHERE status IN ('running','stopping')")) {
    if (activeRuns.has(run.id)) continue;
    if (run.owner_pid) { try { process.kill(run.owner_pid, 0); if (run.owner_pid !== process.pid) continue; } catch { /* 종료된 프로세스 */ } }
    else if (!['grok','codex','gpt','nemotron'].includes(run.model)) continue;
    await repo.run("UPDATE runs SET status='interrupted', error='서버 재시작으로 중단됨. 대화에서 이어서 요청하세요.', ended_at=? WHERE id=?", now(), run.id);
  }
  watchQueue(env);
  for (const row of await repo.all("SELECT DISTINCT conversation_id FROM runs WHERE status='queued' AND conversation_id IS NOT NULL")) dispatchQueue(row.conversation_id, env);
}

function watchQueue(env: Env) {
  if (globals.__radarQueueTimer) return;
  let checking = false;
  globals.__radarQueueTimer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      for (const row of await repository().all("SELECT DISTINCT conversation_id FROM runs WHERE status='queued' AND conversation_id IS NOT NULL")) dispatchQueue(row.conversation_id, env);
    } catch { /* 연결 복구 후 다음 주기에 다시 확인한다. */ }
    finally { checking = false; }
  }, 1500);
  globals.__radarQueueTimer.unref();
}

function dispatchQueue(conversationId: string, env: Env) {
  if (queueWorkers.has(conversationId)) return;
  const repo = repository();
  const worker = (async () => {
    while (true) {
      const next = await queueTransaction(async () => {
        if (!await repo.one('SELECT id FROM conversations WHERE id=?', conversationId)) return;
        if (await repo.one("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", conversationId)) return;
        const row = await repo.one("SELECT * FROM runs WHERE conversation_id=? AND status='queued' ORDER BY rowid LIMIT 1", conversationId);
        if (!row) return;
        const saved = await repo.one("SELECT data FROM events WHERE run_id=? AND name='run.queued' ORDER BY id LIMIT 1", row.id);
        if (!saved) {
          await repo.run("UPDATE runs SET status='failed',error=?,ended_at=? WHERE id=?", '대기 요청 원문을 찾을 수 없습니다', now(), row.id);
          return;
        }
        const input: ChatIn = JSON.parse(saved.data);
        await repo.run("UPDATE runs SET status='running',started_at=?,owner_pid=? WHERE id=? AND status='queued'", now(), process.pid, row.id);
        await repo.message(conversationId, 'user', input.messages[0].text, { ...(input.appContext ? { appContext: input.appContext } : {}), ...(input.reportIds?.length ? { reportIds: input.reportIds } : {}) });
        if (input.appContext) await repo.event(row.id, 'app.context', input.appContext);
        return { input, runId: row.id };
      });
      if (!next) return;
      try { await executeRun(next.input, queuedEnvs.get(next.runId) || env, next.runId).finished; }
      finally { queuedEnvs.delete(next.runId); }
    }
  })().catch(() => { /* 트랜잭션 충돌과 일시적인 연결 실패는 다음 주기에 재시도한다. */ }).finally(() => { queueWorkers.delete(conversationId); });
  queueWorkers.set(conversationId, worker);
}

export async function startRun(input: ChatIn, env: Env) {
  const repo = repository();
  const conversationId = input.conversationId || (await repo.createConversation()).id;
  await repo.conversation(conversationId);
  const last = input.messages.at(-1);
  if (!last || last.role !== 'user' || typeof last.text !== 'string' || !last.text.trim()) throw new Error('사용자 메시지 필요');
  const choice = parseModelChoice(input.model, input.options);
  const runId = randomUUID();
  const appContext = input.appContext ? await validateAppContext(repo, { ...input.appContext, conversationId }) : undefined;
  const reportIds = (await attachedReports(repo, conversationId, input.reportIds)).map(r => r.id);
  const request: ChatIn = { conversationId, model: choice?.provider, ...(choice?.model || choice?.effort ? { options: { model: choice.model, effort: choice.effort } } : {}), messages: [{ role: 'user', text: last.text }], state: input.state, appContext, ...(reportIds.length ? { reportIds } : {}) };
  await queueTransaction(async () => {
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', runId, conversationId, input.model || DEFAULT_MODEL, 'queued', now(), process.pid);
    await repo.event(runId, 'run.queued', request);
    await repo.run('UPDATE conversations SET updated_at=? WHERE id=?', now(), conversationId);
    await repo.run("UPDATE conversations SET title=? WHERE id=? AND title='새 대화'", last.text.slice(0, 60), conversationId);
  });
  queuedEnvs.set(runId, env);
  watchQueue(env); dispatchQueue(conversationId, env);
  return { runId, conversationId, get done() { return waitForRun(runId); } };
}

async function waitForRun(runId: string) {
  while (true) {
    const row = await repository().one('SELECT status FROM runs WHERE id=?', runId);
    if (!row || !['queued', 'running', 'stopping'].includes(row.status)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** 사용자 중지(API·대화 삭제)로 실행을 끝낼 때의 사유 */
export const STOPPED_MESSAGE = '사용자가 조사를 중지했습니다';
class StopRequest extends Error { constructor() { super(STOPPED_MESSAGE); this.name = 'StopRequest'; } }
/** stopGraceMs: 중지 요청 후 모델·CLI 정리를 기다리는 최대 시간. 넘으면 실행을 중지됨으로 확정하고 대기열을 이어간다 */
export const runSettings = { stopGraceMs: 5000 };
const ACTIVE = ['running', 'stopping'];

/** 실행 종료 기록은 한 번만 남긴다. 강제 종료 뒤 늦게 끝난 원래 실행이 상태·메시지를 덮어쓰지 않는다 */
async function finalizeRun(runId: string, conversationId: string, status: 'cancelled' | 'failed', error: string) {
  const repo = repository();
  return queueTransaction(async () => {
    const row = await repo.one('SELECT status FROM runs WHERE id=?', runId);
    if (!row || !ACTIVE.includes(row.status)) return false;
    await repo.run('UPDATE runs SET status=?,error=?,ended_at=? WHERE id=?', status, error, now(), runId);
    if (await repo.conversationExists(conversationId)) await repo.message(conversationId, 'model', error);
    return true;
  });
}

async function assertRunning(runId: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if ((await repository().one('SELECT status FROM runs WHERE id=?', runId))?.status !== 'running') throw new Error('현재 조사 실행이 종료되었습니다');
}

/** 로컬 명령(!모델·!보고서 등) 또는 선택한 모델로 답을 만든다 */
async function answer(input: ChatIn, env: Env, runId: string, signal: AbortSignal) {
  const repo = repository(), conversationId = input.conversationId!, text = input.messages[0].text;
  await repo.prepareWorkspace(conversationId);
  const conversation = await repo.conversation(conversationId);
  const snapshot = await repo.versionedData();
  const names: Record<string, string> = Object.fromEntries(Object.entries(snapshot.data.countries).map(([id, c]) => [id, c.ko]));
  const local = runCommand(text, names);
  if (/^[!！]\s*(?:모델|model)(?:\s|$)/i.test(text)) return { snapshot, local: true, out: { reply: `선택 모델: ${input.model || DEFAULT_MODEL}`, reports: [], actions: [], tools: ['model'] } as ChatOut };
  if (local) return { snapshot, local: true, out: { reply: local.text || '', reports: local.report ? [local.report] : [], actions: local.actions, tools: ['command'] } as ChatOut };
  // 지난 메시지의 첨부 보고서는 파일 위치만, 이번 요청의 첨부 보고서는 본문까지 넘긴다
  const messages = conversation.messages.map((m: any) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.text + (m.reports?.length ? `\n보고서:\n${m.reports.join('\n')}` : '') + (m.reportIds?.length ? `\n[첨부 보고서: ${m.reportIds.map((id: string) => `reports/${id}.md`).join(', ')}]` : '') }));
  const attached = await attachedReports(repo, conversationId, input.reportIds);
  if (attached.length && messages.length) messages[messages.length - 1].text = `${input.messages[0].text}\n\n${reportAttachmentText(attached)}`;
  const files = repo.files(conversationId);
  if (files.length) messages[messages.length - 1].text += `\n\n[대화 작업 파일 목록: ${JSON.stringify(files)}. 필요한 파일은 workspace_read로 읽으세요.]`;
  return { snapshot, local: false, out: await chatWith({ ...input, conversationId, runId, signal, messages }, env) };
}

/** 답변에 포함되거나 실행 중 저장된 보고서를 등록하고 화면 참조를 붙인다 */
async function saveReports(out: ChatOut, conversationId: string, runId: string, revision: () => Promise<number>) {
  const repo = repository();
  for (const saved of await repo.all('SELECT markdown FROM reports WHERE run_id=? ORDER BY created_at,id', runId)) if (!out.reports.includes(saved.markdown)) out.reports.push(saved.markdown);
  for (const report of out.reports) {
    if (await repo.one('SELECT 1 FROM reports WHERE run_id=? AND markdown=?', runId, report)) continue;
    const id = randomUUID(), date = now();
    const dataVersion = await revision();
    const file = await repo.artifact(conversationId, `reports/${id}.md`, report, { runId, kind: 'report', mime: 'text/markdown' });
    await repo.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)', id, conversationId, runId, dataVersion, date.slice(0, 10), report, repo.storedPath(file.path), date);
  }
  const savedReports = await repo.all('SELECT * FROM reports WHERE run_id=? ORDER BY created_at,id', runId);
  const used = new Set<string>();
  out.reportRefs = out.reports.map(markdown => {
    const row = savedReports.find(r => r.markdown === markdown && !used.has(r.id));
    if (!row) return null;
    used.add(row.id);
    return { id: row.id, ...reportTarget(row.markdown), kind: 'country-analysis', basisDate: row.basis_date, dataVersion: row.data_version };
  });
}

function executeRun(input: ChatIn, env: Env, runId: string) {
  const repo = repository(), conversationId = input.conversationId!, appContext = input.appContext;
  const controller = new AbortController();
  let settle!: () => void;
  // finished: 실행이 끝났거나 중지가 확정된 시점. 대기열은 이것을 기다린다.
  const finished = new Promise<void>(resolve => { settle = resolve; });
  let checking = false;
  // 다른 프로세스(MCP cancel_run 등)의 중지도 반영한다.
  const cancellation = setInterval(async () => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    try {
      const current = await repo.one('SELECT status FROM runs WHERE id=?', runId);
      if (current?.status === 'stopping') controller.abort(new StopRequest());
      else if (current?.status !== 'running') controller.abort(new Error('종료되거나 중지된 조사 실행'));
    } catch { controller.abort(new Error('조사 실행 상태 확인 실패')); }
    finally { checking = false; }
  }, 1000);
  // 중지 후 CLI·모델 호출이 정해진 시간 안에 정리되지 않아도 실행을 중지됨으로 확정한다.
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  controller.signal.addEventListener('abort', () => {
    watchdog = setTimeout(() => { void finalizeRun(runId, conversationId, 'cancelled', STOPPED_MESSAGE).catch(() => {}).finally(settle); }, runSettings.stopGraceMs);
    watchdog.unref?.();
  }, { once: true });
  const done = executions.run({ conversationId, runId, signal: controller.signal, repo, env, appContext }, async () => {
    try {
      await execution();
      const { out, local, snapshot } = await answer(input, env, runId, controller.signal);
      await assertRunning(runId, controller.signal);
      if (['codex', 'grok'].includes(input.model || '')) out.files = await collectDocuments(executions.getStore()!);
      await saveReports(out, conversationId, runId, async () => local ? snapshot.revision : await repo.revision());
      await repo.syncWorkspace(conversationId);
      await assertRunning(runId, controller.signal);
      await repo.transaction(async () => {
        await execution();
        await repo.message(conversationId, 'model', out.error ? `${out.error}${out.detail ? `\n${out.detail}` : ''}` : out.reply, out);
        await repo.run('UPDATE runs SET status=?,error=?,ended_at=?,result=? WHERE id=?', out.error ? 'failed' : 'completed', out.error || null, now(), JSON.stringify(out), runId);
      }, controller.signal);
    } catch (e) {
      const status = (await repo.one('SELECT status FROM runs WHERE id=?', runId).catch(() => undefined))?.status;
      const reason = controller.signal.aborted ? controller.signal.reason : e;
      const userStop = reason instanceof StopRequest || ['stopping', 'cancelled'].includes(status);
      await finalizeRun(runId, conversationId, userStop ? 'cancelled' : 'failed', userStop ? STOPPED_MESSAGE : String(reason instanceof Error ? reason.message : reason)).catch(() => {});
    } finally {
      clearInterval(cancellation); clearTimeout(watchdog); activeRuns.delete(runId); settle();
    }
  });
  activeRuns.set(runId, { controller, done, finished });
  return { runId, conversationId, done, finished };
}

/** 대기 요청은 실행하지 않고 취소하고, 진행 중 요청은 중지 상태로 바꾼 뒤 모델·CLI 프로세스를 중단한다 */
export async function stopRun(runId: string) {
  const repo = repository();
  await repo.run("UPDATE runs SET status='cancelled',error=?,ended_at=? WHERE id=? AND status='queued'", '대기 메시지를 취소했습니다', now(), runId);
  queuedEnvs.delete(runId);
  // 상태를 먼저 바꿔 중지 직후 끝난 답변이 완료로 저장되지 않게 한다.
  await repo.run("UPDATE runs SET status='stopping' WHERE id=? AND status='running'", runId);
  const live = activeRuns.get(runId);
  if (!live) return;
  live.controller.abort(new StopRequest());
  await live.finished;
}

export async function stopConversation(conversationId: string) {
  await repository().run("UPDATE runs SET status='cancelled',error=?,ended_at=? WHERE conversation_id=? AND status='queued'", '대화 삭제로 대기 취소됨', now(), conversationId);
  for (const run of await repository().all("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", conversationId)) await stopRun(run.id);
}
