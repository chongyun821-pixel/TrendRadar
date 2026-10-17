import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { repository, PROJECT_ROOT, now } from './store';
import { executions } from './execution';
import { loadDevVars } from './devvars';
import { runTool, newOut } from './agent';
import type { AppContext } from '../shared/app-context';
import type { Env } from './gemma';
import { saveAppContext } from './app-context';

export async function executeTool(name: string, args: Record<string, any>, options: { conversationId?: string; runId?: string; env?: Env; appContext?: AppContext } = {}) {
  const repo = repository();
  await repo.data();
  const conversationId = options.conversationId || (await repo.createConversation('MCP 도구 실행')).id;
  await repo.conversation(conversationId);
  const runId = options.runId || randomUUID();
  if (!options.runId) await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', runId, conversationId, 'mcp', 'running', now(), process.pid);
  else if (!await repo.one("SELECT id FROM runs WHERE id=? AND conversation_id=? AND status='running'", runId, conversationId)) throw new Error('유효한 대화 실행이 아닙니다');
  const saved = await repo.one("SELECT data FROM events WHERE run_id=? AND name='app.context' ORDER BY id LIMIT 1", runId);
  try {
    const appContext = saved ? JSON.parse(saved.data) : options.appContext ? await saveAppContext(repo, { ...options.appContext, conversationId }) : undefined;
    if (!saved && appContext) await repo.event(runId, 'app.context', appContext);
    await repo.prepareWorkspace(conversationId);
    const result = await executions.run({ conversationId, runId, repo, signal: new AbortController().signal, env: options.env || { ...process.env, ...loadDevVars(join(PROJECT_ROOT, '.secrets')) }, appContext }, () => runTool(name, args, newOut()));
    if (!options.runId) {
      await repo.run("UPDATE runs SET status=?,ended_at=? WHERE id=? AND status='running'", result && typeof result === 'object' && 'error' in result ? 'failed' : 'completed', now(), runId);
      await repo.run("UPDATE runs SET status='cancelled',ended_at=? WHERE id=? AND status='stopping'", now(), runId);
    }
    return { result, conversationId, runId };
  } catch (error) {
    if (!options.runId) await repo.run("UPDATE runs SET status='failed',error=?,ended_at=? WHERE id=? AND status='running'", String(error), now(), runId);
    throw error;
  }
}
