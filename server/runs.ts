import { randomUUID } from 'node:crypto';
import { executions } from './execution';
import { collectDocuments } from './artifacts';
import { repository, now } from './store';
import { chatWith } from './models';
import type { ChatIn, ChatOut } from './agent';
import type { Env } from './gemma';
import { runCommand } from '../src/commands';

const globals = globalThis as typeof globalThis & { __radarRuns?: Map<string, { controller: AbortController; done: Promise<void> }> };
export const activeRuns = globals.__radarRuns ??= new Map();
export function recoverRuns() {
  const repo = repository();
  for (const run of repo.all("SELECT id,owner_pid,model FROM runs WHERE status IN ('running','stopping')")) {
    if (activeRuns.has(run.id)) continue;
    if (run.owner_pid) { try { process.kill(run.owner_pid, 0); if (run.owner_pid !== process.pid) continue; } catch { /* 종료된 프로세스 */ } }
    else if (!['grok','codex','gemma','nemotron'].includes(run.model)) continue;
    repo.run("UPDATE runs SET status='interrupted', error='서버 재시작으로 중단됨. 대화에서 이어서 요청하세요.', ended_at=? WHERE id=?", now(), run.id);
  }
}
export function startRun(input: ChatIn, env: Env) {
  const repo = repository();
  const conversationId = input.conversationId || repo.createConversation().id;
  repo.conversation(conversationId);
  if (repo.one("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", conversationId)) throw new Error('이 대화의 조사가 진행 중입니다');
  const last = input.messages.at(-1);
  if (!last || last.role !== 'user' || !last.text.trim()) throw new Error('사용자 메시지 필요');
  const runId = randomUUID(), controller = new AbortController();
  repo.transaction(() => {
    repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', runId, conversationId, input.model || 'gemma', 'running', now(), process.pid);
    repo.message(conversationId, 'user', last.text);
  });
  let begin!: () => void;
  const gate = new Promise<void>(r => { begin = r; });
  const cancellation = setInterval(() => {
    const current = repo.one('SELECT status FROM runs WHERE id=?', runId);
    if (current?.status !== 'running') controller.abort(new Error('종료되거나 중지된 조사 실행'));
  }, 1000);
  const done = gate.then(() => executions.run({ conversationId, runId, signal: controller.signal, repo, env }, async () => {
    try {
      const conversation = repo.conversation(conversationId);
      const names: Record<string, string> = Object.fromEntries(Object.entries(repo.data().countries).map(([id, c]) => [id, c.ko]));
      const local = runCommand(last.text, names);
      let out: ChatOut;
      if (/^[!！]\s*(?:모델|model)(?:\s|$)/i.test(last.text)) {
        out = { reply: `선택 모델: ${input.model || 'gemma'}`, reports: [], actions: [], tools: ['model'] };
      } else if (local) {
        out = { reply: local.text || '', reports: local.report ? [local.report] : [], actions: local.actions, tools: ['command'] };
      } else {
        const messages = conversation.messages.map((m: any) => ({ role: m.role === 'user' ? 'user' as const : 'model' as const, text: m.text + (m.reports?.length ? `\n보고서:\n${m.reports.join('\n')}` : '') }));
        const files = repo.files(conversationId);
        messages[messages.length - 1].text += files.length ? `\n\n[대화 작업 파일 목록: ${JSON.stringify(files)}. 필요한 파일은 workspace_read로 읽으세요.]` : '';
        out = await chatWith({ ...input, conversationId, runId, signal: controller.signal, messages }, env);
      }
      controller.signal.throwIfAborted();
      if (repo.one('SELECT status FROM runs WHERE id=?', runId)?.status !== 'running') throw new Error('현재 조사 실행이 종료되었습니다');
      if (['codex', 'grok'].includes(input.model || '')) out.files = collectDocuments(executions.getStore()!);
      for (const report of out.reports) {
        if (!repo.one('SELECT 1 FROM reports WHERE run_id=? AND markdown=?', runId, report)) {
          const id = randomUUID(), date = now();
          const file = repo.artifact(conversationId, `reports/${id}.md`, report, { runId, kind: 'report', mime: 'text/markdown' });
          repo.run('INSERT INTO reports VALUES(?,?,?,?,?,?,?,?)', id, conversationId, runId, repo.revision(), date.slice(0, 10), report, file.path, date);
        }
      }
      if (out.error) repo.message(conversationId, 'model', `${out.error}${out.detail ? `\n${out.detail}` : ''}`, out);
      else repo.message(conversationId, 'model', out.reply, out);
      repo.run('UPDATE runs SET status=?,error=?,ended_at=?,result=? WHERE id=?', out.error ? 'failed' : 'completed', out.error || null, now(), JSON.stringify(out), runId);
    } catch (e) {
      const stopped = controller.signal.aborted;
      const error = stopped ? '사용자가 조사를 중지했습니다' : String(e);
      repo.run('UPDATE runs SET status=?,error=?,ended_at=? WHERE id=?', stopped ? 'cancelled' : 'failed', error, now(), runId);
      if (repo.one('SELECT id FROM conversations WHERE id=?', conversationId)) repo.message(conversationId, 'model', error);
    } finally { clearInterval(cancellation); activeRuns.delete(runId); }
  }));
  activeRuns.set(runId, { controller, done });
  begin();
  return { runId, conversationId, done };
}
export async function stopRun(runId: string) {
  const live = activeRuns.get(runId);
  repository().run("UPDATE runs SET status='stopping' WHERE id=? AND status='running'", runId);
  if (!live) return;
  live.controller.abort(new Error('사용자 중지'));
  await live.done;
}
