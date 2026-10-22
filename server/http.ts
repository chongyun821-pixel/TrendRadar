/** 모델 HTTP 호출 공통: 응답 오류와 중지 가능한 대기 */
export class ReqError extends Error { constructor(public status: number, public body: string) { super(`HTTP ${status}`); } }

/** 중지 신호가 오면 바로 끝나는 대기(재시도 간격용) */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
