/**
 * 로컬 전용 엔드포인트 보호: 루프백 주소에서 온, 로컬 Host 이름의, 같은 출처(또는 Origin 없음) 요청만 받는다.
 * Host 확인은 DNS 리바인딩(다른 도메인이 127.0.0.1을 가리키게 하는 공격)을, Origin 확인은 다른 사이트의 요청을 막는다.
 */
const REMOTE: WeakMap<object, string> = ((globalThis as any).__radarRemoteAddress ??= new WeakMap<object, string>());

/** Node 서버(vite 개발 서버·server/node.ts)가 요청 객체에 접속 주소를 붙인다. Workers 등에는 없어 로컬 전용 경로가 거절된다 */
export function rememberRemote(request: object, address: string | undefined) { if (address) REMOTE.set(request, address); }
export const remoteOf = (request: object) => REMOTE.get(request);
export const isLoopbackAddress = (a?: string) => !!a && (a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.'));
export function isLoopbackHost(host?: string | null) {
  if (!host) return false;
  try { const h = new URL(`http://${host}`).hostname; return h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h); } catch { return false; }
}
/** 거절 사유(한국어) 또는 null */
export function localOnly(o: { remote?: string; host?: string | null; origin?: string | null }): string | null {
  if (!isLoopbackAddress(o.remote)) return '이 컴퓨터(localhost)에서 온 요청만 받습니다';
  if (!isLoopbackHost(o.host)) return 'localhost 주소로 접속한 요청만 받습니다';
  if (o.origin) { let same = false; try { same = new URL(o.origin).host === o.host; } catch { /* 잘못된 Origin */ } if (!same) return '다른 출처의 요청은 받지 않습니다'; }
  return null;
}
/** 같은 컴퓨터의 다른 프로세스가 이 서버에 접속할 주소. 루프백이 아닌 주소(0.0.0.0·LAN)로 열었으면 127.0.0.1을 쓴다 */
export function localServerUrl(address: string, port: number) {
  const host = address === '::1' ? '[::1]' : address === 'localhost' || /^127\./.test(address) ? address : '127.0.0.1';
  return `http://${host}:${port}`;
}
