/**
 * 화면 명령 처리: 1초마다 화면 상태를 동기화하고 이 화면에 온 명령을 적용한 뒤 결과를 확인 응답한다.
 * 탭이 숨겨진 동안은 적용하지 않고, 다시 보이면 바로 적용한다.
 * 명령은 요청 당시 화면 버전과 같거나, 같은 실행이 적용한 변경으로만 이어진 경우에만 적용한다.
 */
import { api, post } from './chat-api';
import { commandVersionMatches, type AppliedCommandVersion, type AppContext } from '../shared/app-context';

export type CommandResult = { status: string; detail?: string; version?: number };
export interface ScreenCommand { id: string; run_id: string; conversation_id: string; expected_version: number; data: any }

export function createScreenCommands(o: {
  screenId: string;
  snapshot(): AppContext;
  sync(force?: boolean): Promise<AppContext>;
  /** 명령 적용. matches()로 적용 직전 화면이 그대로인지 다시 확인한다 */
  apply(command: ScreenCommand, matches: () => boolean): Promise<CommandResult | void>;
}) {
  const appliedVersions = new Map<string, AppliedCommandVersion[]>();
  const pendingAcks = new Map<string, CommandResult & { state: AppContext }>();
  let syncing = false;
  const applied = (runId: string) => appliedVersions.get(runId) || [];
  function matches(command: ScreenCommand) {
    const before = o.snapshot();
    return before.conversationId === command.conversation_id && (before.version === command.expected_version ||
      !!command.data.chain && commandVersionMatches(command.expected_version, before.version, applied(command.run_id)));
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
        if (!matches(command)) result = { status: 'conflict', detail: '요청 이후 사용자가 화면 상태를 변경했습니다' };
        else {
          try { result = (await o.apply(command, () => matches(command))) || { status: 'applied' }; }
          catch (error) { result = { status: 'failed', detail: String(error) }; }
        }
        if (result.status === 'applied') {
          result.version = o.snapshot().version;
          appliedVersions.set(command.run_id, [...applied(command.run_id), { expectedVersion: command.expected_version, version: result.version }]);
        }
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
    /** 요청 당시 화면 버전에서 지금 화면까지 같은 실행의 명령만으로 왔는지 */
    mayChangeView: (runId: string, requestVersion: number | undefined) => requestVersion === undefined || commandVersionMatches(requestVersion, o.snapshot().version, applied(runId)),
  };
}
