/**
 * 화면 명령 처리: 1초마다 화면 상태를 동기화하고 이 화면에 온 명령을 적용한 뒤 결과를 확인 응답한다.
 * 탭이 숨겨진 동안은 적용하지 않고, 다시 보이면 바로 적용한다.
 * 챗봇의 명령은 사용자가 그사이 화면을 바꿨더라도 같은 대화의 화면이면 항상 적용한다.
 */
import { api, post } from './chat-api';
import type { AppContext } from '../shared/app-context';

export type CommandResult = { status: string; detail?: string; version?: number };
export interface ScreenCommand { id: string; run_id: string; conversation_id: string; expected_version: number; data: any }

export function createScreenCommands(o: {
  screenId: string;
  snapshot(): AppContext;
  sync(force?: boolean): Promise<AppContext>;
  /** 명령 적용. matches()로 적용 직전 화면이 그대로인지 다시 확인한다 */
  apply(command: ScreenCommand, matches: () => boolean): Promise<CommandResult | void>;
}) {
  const pendingAcks = new Map<string, CommandResult & { state: AppContext }>();
  let syncing = false;
  function matches(command: ScreenCommand) {
    const before = o.snapshot();
    return before.conversationId === command.conversation_id;
  }
  async function acknowledge(id: string, result: CommandResult & { state: AppContext }) {
    pendingAcks.set(id, result);
    await api(`/app-context/${o.screenId}/commands/${id}`, post(result));
    pendingAcks.delete(id);
  }
  async function pulse() {
    if (syncing || document.hidden) return;
    syncing = true;
    try {
      // 실패한 적용 확인을 먼저 재전송해 화면 버전과 명령 결과 사이의 공백을 방지한다.
      for (const [id, result] of pendingAcks) await acknowledge(id, result);
      await o.sync();
      const commands: ScreenCommand[] = await api(`/app-context/${o.screenId}/commands`);
      for (const command of commands) {
        let result: CommandResult;
        if (!matches(command)) result = { status: 'conflict', detail: '화면이 다른 대화로 바뀌었습니다' };
        else {
          try { result = (await o.apply(command, () => matches(command))) || { status: 'applied' }; }
          catch (error) { result = { status: 'failed', detail: String(error) }; }
        }
        if (result.status === 'applied') result.version = o.snapshot().version;
        await acknowledge(command.id, { ...result, state: o.snapshot() });
      }
    } catch { /* 일시적인 통신 실패는 다음 주기에 재시도한다. */ }
    finally { syncing = false; }
  }
  return {
    start() {
      setInterval(() => { void pulse(); }, 1000); void pulse();
      // 숨김 전환을 바로 알리고, 다시 보이면 그동안 쌓인 명령을 곧바로 적용한다
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) void o.sync(true).catch(() => {});
        else void o.sync(true).catch(() => {}).then(() => pulse());
      });
    },
    /** 답변과 함께 온 화면 동작·보고서 표시는 사용자가 그사이 화면을 바꿨더라도 적용한다 */
    mayChangeView: (_runId: string, _requestVersion: number | undefined) => true,
  };
}
