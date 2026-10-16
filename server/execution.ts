import { AsyncLocalStorage } from 'node:async_hooks';
import type { Env } from './gemma';
import type { Repository } from './store';

export interface Execution { conversationId: string; runId: string; signal: AbortSignal; repo: Repository; env: Env }
const runtime = globalThis as typeof globalThis & { __radarExecution?: AsyncLocalStorage<Execution> };
export const executions = runtime.__radarExecution ??= new AsyncLocalStorage<Execution>();
export function execution() {
  const value = executions.getStore();
  if (!value) throw new Error('대화·조사 실행을 먼저 시작해야 합니다');
  value.signal.throwIfAborted();
  const run = value.repo.one('SELECT status FROM runs WHERE id=?', value.runId);
  if (!run || !['running'].includes(run.status)) throw new Error('종료되거나 중지된 조사 실행');
  return value;
}
