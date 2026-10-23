/**
 * 화면 허브: 열린 지도 화면(브라우저 탭)과 앱 서버 사이의 실시간 연결. DB를 쓰지 않고 앱 서버 메모리에만 둔다.
 *  - 브라우저는 GET /api/screen/events(SSE)로 연결해 명령을 받고, 적용 결과를 POST /api/screen/results/:id로 돌려준다.
 *    화면 상태(모드·국가·2D/3D·보고서·탭 숨김)는 POST /api/screen/state로 바뀔 때마다 알린다.
 *  - MCP 서버·모델 도구는 POST /api/screen/command로 명령을 보내고 적용 결과(applied·failed)를 동기로 받는다.
 *    연결된 화면이 없으면 바로 inactive, 제시간에 답이 없으면 timeout.
 *  - 대화별 대상 지정은 없다. 탭이 여러 개면 보이는 탭 중 가장 최근에 사용한(연결·포커스·조작) 탭 하나로 보낸다.
 * 앱 서버 프로세스 안(지피티·네모트론 실행, /api/tools)은 허브를 직접 부르고, 다른 프로세스(MCP stdio·HTTP)는 RADAR_APP_URL로 HTTP 요청한다.
 */
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../shared/app-context';

export type ScreenStatus = 'applied' | 'failed' | 'inactive' | 'timeout';
export interface ScreenResult { ok: boolean; status: ScreenStatus | 'queued'; screenId?: string; detail?: string; message?: string; error?: string; hidden?: boolean; screen?: AppContext }
export const SCREEN_COMMANDS = ['set_map_state', 'show_report', 'switch_conversation', 'set_chat_model'] as const;
export type ScreenCommandData = { type: typeof SCREEN_COMMANDS[number] } & Record<string, unknown>;

/** 결과 대기 시간(ms). RADAR_SCREEN_TIMEOUT_MS로 바꾸고 테스트는 줄일 수 있다 */
export const screenSettings = { timeoutMs: Number(process.env.RADAR_SCREEN_TIMEOUT_MS) || 6000 };
export const SCREEN_MESSAGES = {
  inactive: '화면이 열려 있지 않음: 앱 지도 화면(브라우저 탭)이 열려 있지 않아 화면을 바꾸지 못했다. 앱을 열고 다시 요청해 달라고 사용자에게 한 줄로 알린다',
  noServer: '화면이 열려 있지 않음: 앱 서버(npm run dev)가 실행 중이 아니어서 화면을 바꾸지 못했다. 앱을 실행·열고 다시 요청해 달라고 사용자에게 한 줄로 알린다',
  timeout: '화면이 제시간에 응답하지 않아 적용 여부를 확인하지 못했다. 화면을 확인해 달라고 사용자에게 한 줄로 알린다',
  closed: '명령을 적용하기 전에 화면 연결이 끊겼다. 앱 화면을 열고 다시 요청해 달라고 사용자에게 한 줄로 알린다',
  hidden: '앱 탭이 백그라운드에 있다. 적용은 끝났고 탭을 열면 바뀐 화면이 보인다',
};
export const screenFail = (status: ScreenStatus, message: string, extra: Partial<ScreenResult> = {}): ScreenResult => ({ ok: false, status, message, error: message, ...extra });

interface Screen { id: string; state?: AppContext; hidden: boolean; activeAt: number; updatedAt: number; send(event: string, data: unknown): void }
interface Pending { screenId: string; resolve(result: ScreenResult): void }
interface Hub { hosted: boolean; screens: Map<string, Screen>; pending: Map<string, Pending>; clock: number }
// vite 개발 서버는 모듈을 다시 읽을 수 있어 연결 목록을 전역에 둔다
const hub: Hub = ((globalThis as any).__radarScreenHub ??= { hosted: false, screens: new Map(), pending: new Map(), clock: 0 });
/** 같은 밀리초의 활동도 순서를 구분한다 */
const tick = () => (hub.clock = Math.max(hub.clock + 1, Date.now()));

/** 앱 서버가 허브를 연다(server/app.ts가 불린 프로세스). 이 프로세스의 화면 도구는 HTTP 없이 허브를 직접 쓴다 */
export function hostScreens() { hub.hosted = true; }
export const hostsScreens = () => hub.hosted;

export function connectScreen(id: string, send: Screen['send']) {
  // 같은 탭이 다시 연결하면(네트워크 끊김·서버 재시작) 상태와 활동 순서를 이어받아 다른 탭을 앞지르지 않는다
  const previous = hub.screens.get(id);
  const screen: Screen = { id, hidden: previous?.hidden ?? false, activeAt: previous?.activeAt ?? tick(), updatedAt: Date.now(), send, state: previous?.state };
  hub.screens.set(id, screen);
  return () => {
    if (hub.screens.get(id) !== screen) return; // 같은 화면이 다시 연결했으면 새 연결을 유지한다
    hub.screens.delete(id);
    for (const [commandId, p] of hub.pending) if (p.screenId === id) { hub.pending.delete(commandId); p.resolve(screenFail('inactive', SCREEN_MESSAGES.closed, { screenId: id })); }
  };
}
/** 화면 상태·탭 숨김·활동 알림. 연결 전에 온 상태도 받아 둔다(연결하면 이어받는다) */
export function updateScreen(id: string, o: { state?: AppContext; hidden?: boolean; active?: boolean }) {
  const screen = hub.screens.get(id);
  if (!screen) return false;
  if (o.state) screen.state = o.state;
  if (o.hidden !== undefined) screen.hidden = o.hidden;
  if (o.active) screen.activeAt = tick();
  screen.updatedAt = Date.now();
  return true;
}
/** 명령 대상: 보이는 탭 우선, 그다음 가장 최근 활동 */
export function targetScreen(): Screen | undefined {
  return [...hub.screens.values()].sort((a, b) => Number(a.hidden) - Number(b.hidden) || b.activeAt - a.activeAt)[0];
}
export function screenSnapshot() {
  const screen = targetScreen();
  if (!screen) return { available: false as const, screens: 0, reason: '화면이 열려 있지 않음(연결된 앱 화면 없음)' };
  return { available: true as const, screenId: screen.id, screens: hub.screens.size, hidden: screen.hidden, observedAt: new Date(screen.updatedAt).toISOString(), state: screen.state ?? null };
}
export function completeCommand(screenId: string, id: string, result: { status: 'applied' | 'failed'; detail?: string; state?: AppContext }) {
  const p = hub.pending.get(id);
  if (!p || p.screenId !== screenId) return false;
  hub.pending.delete(id);
  const screen = hub.screens.get(screenId);
  if (result.state && screen) { screen.state = result.state; screen.updatedAt = Date.now(); }
  const extra = { screenId, ...(screen?.hidden ? { hidden: true } : {}), ...(result.state ? { screen: result.state } : {}) };
  p.resolve(result.status === 'applied'
    ? { ok: true, status: 'applied', ...extra, ...(screen?.hidden ? { message: SCREEN_MESSAGES.hidden } : {}) }
    : screenFail('failed', `화면 적용 실패: ${result.detail || '원인 미상'}. 사용자에게 한 줄로 알린다`, { ...extra, detail: result.detail }));
  return true;
}
/** 허브에서 바로 보낸다(앱 서버 프로세스 안) */
export function dispatchScreenCommand(data: ScreenCommandData, timeoutMs = screenSettings.timeoutMs, signal?: AbortSignal): Promise<ScreenResult> {
  const screen = targetScreen();
  if (!screen) return Promise.resolve(screenFail('inactive', SCREEN_MESSAGES.inactive));
  const id = randomUUID();
  return new Promise<ScreenResult>(resolve => {
    const done = (r: ScreenResult) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); hub.pending.delete(id); resolve(r); };
    const timer = setTimeout(() => done(screenFail('timeout', SCREEN_MESSAGES.timeout, { screenId: screen.id })), timeoutMs);
    const abort = () => done(screenFail('failed', '실행이 중지되어 화면 결과를 기다리지 않았다', { screenId: screen.id }));
    signal?.addEventListener('abort', abort, { once: true });
    hub.pending.set(id, { screenId: screen.id, resolve: done });
    try { screen.send('command', { id, data }); } catch { done(screenFail('inactive', SCREEN_MESSAGES.closed, { screenId: screen.id })); }
  });
}

/* ───────── 다른 프로세스(MCP)에서 쓰는 클라이언트 ───────── */
/** 앱 서버 주소. RADAR_APP_URL(앱 서버는 시작할 때 자기 주소로 채운다), 기본 http://127.0.0.1:62356 */
export const appUrl = () => (process.env.RADAR_APP_URL || 'http://127.0.0.1:62356').replace(/\/+$/, '');

/** 화면 명령: 같은 프로세스에 허브가 있으면 직접, 아니면 앱 서버로 HTTP 요청한다 */
export async function sendScreenCommand(data: ScreenCommandData, signal?: AbortSignal): Promise<ScreenResult> {
  if (hub.hosted) return dispatchScreenCommand(data, screenSettings.timeoutMs, signal);
  try {
    const timeout = AbortSignal.timeout(screenSettings.timeoutMs + 3000);
    const response = await fetch(`${appUrl()}/api/screen/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, timeoutMs: screenSettings.timeoutMs }), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const body = await response.json().catch(() => null);
    if (body && typeof body.status === 'string') return body as ScreenResult;
    return screenFail('inactive', SCREEN_MESSAGES.noServer, { detail: `앱 서버 응답 ${response.status}` });
  } catch (error) {
    if (signal?.aborted) throw error;
    return (error as Error)?.name === 'TimeoutError' ? screenFail('timeout', SCREEN_MESSAGES.timeout) : screenFail('inactive', SCREEN_MESSAGES.noServer);
  }
}
/** 지금 화면 상태(가장 최근 활성 탭). 앱 서버가 없으면 available=false */
export async function currentScreen(): Promise<ReturnType<typeof screenSnapshot> | { available: false; screens: 0; reason: string }> {
  if (hub.hosted) return screenSnapshot();
  try {
    const response = await fetch(`${appUrl()}/api/screen/context`, { signal: AbortSignal.timeout(2000) });
    if (response.ok) return await response.json();
  } catch { /* 앱 서버 없음 */ }
  return { available: false, screens: 0, reason: '화면이 열려 있지 않음(앱 서버에 연결할 수 없음)' };
}
