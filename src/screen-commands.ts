/**
 * 화면 연결: 앱 서버의 화면 허브에 SSE(/api/screen/events)로 연결해 MCP, 모델이 보낸 화면 명령을 바로 적용하고 결과를 돌려준다.
 *  - 명령은 받은 순서대로 하나씩 적용한다. 결과 전송이 실패하면 다시 보내되 명령을 다시 적용하지는 않는다.
 *  - 화면 상태(지도, 보고서, 대화, 모델, 탭 숨김)는 바뀔 때만 알린다(1초마다 이 탭 안에서 비교, 서버, DB 조회 없음).
 *  - 포커스, 클릭, 키 입력, 탭 표시를 활동으로 알린다. 서버는 보이는 탭 중 가장 최근에 사용한 탭 하나로 명령을 보낸다.
 * 백그라운드 탭도 명령을 적용하며(지도 상태만 바뀐다), 결과에 hidden이 붙는다.
 */
import { api, post } from './chat-api';
import type { AppContext } from '../shared/app-context';

export interface ScreenCommand { id: string; data: any }

export function createScreenCommands(o: {
  screenId: string;
  snapshot(): AppContext;
  /** 명령 적용. 실패하면 예외(사유가 결과 detail로 간다) */
  apply(command: ScreenCommand): Promise<void>;
}) {
  let source: EventSource | null = null, retry: ReturnType<typeof setTimeout> | undefined;
  let chain = Promise.resolve(), sent = '', activeAt = 0;
  const applied = new Set<string>();
  const signature = () => JSON.stringify(o.snapshot()) + (document.hidden ? ':hidden' : '');
  async function postRetry(path: string, body: unknown, tries = 3) {
    for (let i = 1; ; i++) {
      try { return await api(path, post(body)); }
      catch (error) { if (i >= tries) throw error; await new Promise(resolve => setTimeout(resolve, 200 * i)); }
    }
  }
  /** 상태 알림. active면 이 탭을 가장 최근에 사용한 탭으로 표시한다 */
  async function report(active = false) {
    const now = signature();
    if (!active && now === sent) return;
    sent = now;
    try {
      const r = await api('/screen/state', post({ screenId: o.screenId, state: o.snapshot(), hidden: document.hidden, ...(active ? { active: true } : {}) }));
      if (r.connected === false) connect(); // 서버가 이 탭의 연결을 모른다(서버 재시작 등)
    } catch { sent = ''; /* 다음 주기에 다시 보낸다 */ }
  }
  function activity() {
    if (document.hidden || Date.now() - activeAt < 2000) return;
    activeAt = Date.now(); void report(true);
  }
  async function run(command: ScreenCommand) {
    if (applied.has(command.id)) return;
    applied.add(command.id);
    let result: { status: 'applied' | 'failed'; detail?: string };
    try { await o.apply(command); result = { status: 'applied' }; }
    catch (error) { result = { status: 'failed', detail: error instanceof Error ? error.message : String(error) }; }
    sent = signature();
    await postRetry(`/screen/results/${encodeURIComponent(command.id)}`, { screenId: o.screenId, ...result, state: o.snapshot() }).catch(() => { /* 서버가 시간 초과로 처리한다 */ });
  }
  function connect() {
    clearTimeout(retry); source?.close();
    source = new EventSource(`/api/screen/events?screen=${encodeURIComponent(o.screenId)}`);
    source.addEventListener('ready', () => { sent = ''; void report(document.hasFocus()); });
    source.addEventListener('command', event => {
      let command: ScreenCommand;
      try { command = JSON.parse((event as MessageEvent).data); } catch { return; }
      chain = chain.then(() => run(command));
    });
    // 연결이 끊기면 브라우저가 다시 연결한다. 서버가 거절해 닫힌 경우만 잠시 뒤 다시 시도한다
    source.onerror = () => { if (source?.readyState === EventSource.CLOSED) retry = setTimeout(connect, 3000); };
  }
  return {
    start() {
      connect();
      setInterval(() => { void report(); }, 1000);
      document.addEventListener('visibilitychange', () => { if (document.hidden) void report(); else { activeAt = 0; activity(); } });
      addEventListener('focus', () => { activeAt = 0; activity(); });
      addEventListener('pointerdown', activity, { capture: true, passive: true });
      addEventListener('keydown', activity, { capture: true, passive: true });
    },
    /** 화면 상태가 바뀐 직후 바로 알린다 */
    sync: () => report(),
  };
}
