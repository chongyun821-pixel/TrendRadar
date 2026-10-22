/**
 * CLI 자식 프로세스 실행과 중지. Node 전용(호출하는 쪽에서 동적 import 로 불러 Workers 번들에 넣지 않는다).
 * 중지 시 직계 자식만이 아니라 프로세스 트리(MCP 서버·네이티브 실행 파일 등 손자 프로세스)까지 종료한다.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface ProcessResult { code: number | null; stdout: string; stderr: string; timedOut: boolean; killed: boolean }
export interface ProcessOptions {
  cwd: string; input?: string; env?: NodeJS.ProcessEnv;
  /** 0 이하면 시간 제한 없음 */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** stdout 한 줄마다 순서대로 호출한다 */
  onData?: (line: string) => void | Promise<void>;
  /** SIGTERM 뒤 SIGKILL 까지 기다리는 시간 */
  graceMs?: number;
}

/** pid 의 모든 하위 프로세스(POSIX). ps 가 없으면 빈 목록 */
export function descendants(pid: number): number[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || !Number.isFinite(parent)) continue;
    children.set(parent, [...(children.get(parent) || []), child]);
  }
  const out: number[] = [], stack = [pid];
  while (stack.length) for (const c of children.get(stack.pop()!) || []) { out.push(c); stack.push(c); }
  return out;
}

/**
 * 프로세스 트리 종료. Windows 는 taskkill /T, POSIX 는 하위 프로세스 목록을 먼저 구해 함께 신호를 보낸다.
 * 서버를 터미널에서 끝낼 때 자식도 같이 끝나도록 별도 프로세스 그룹(detached)은 쓰지 않는다.
 * 돌려준 pid 목록은 SIGKILL 단계에서 다시 쓴다(부모가 죽으면 하위 프로세스의 부모가 바뀌므로).
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM', known: number[] = []): number[] {
  const pid = child.pid;
  if (pid == null) return known;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
    return known;
  }
  const tree = [...new Set([...known, ...descendants(pid)])];
  for (const id of [pid, ...tree]) { try { process.kill(id, signal); } catch { /* 이미 종료 */ } }
  return tree;
}

export function runProcess(cmd: string, args: string[], o: ProcessOptions): Promise<ProcessResult> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', pending = '', timedOut = false, killed = false, done = false;
    let events = Promise.resolve();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, f: () => void) => { const t = setTimeout(f, ms); t.unref?.(); timers.push(t); };
    const p = spawn(cmd, args, { cwd: o.cwd, env: o.env, windowsHide: true, shell: false });
    const stop = () => {
      if (killed) return;
      killed = true;
      const tree = killTree(p, 'SIGTERM');
      // 종료 후에도 남은 하위 프로세스를 정리하도록 이 타이머는 완료 시 취소하지 않는다.
      setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) killTree(p, 'SIGKILL', tree);
        else for (const id of tree) { try { process.kill(id, 'SIGKILL'); } catch { /* 이미 종료 */ } }
      }, o.graceMs ?? 1500).unref?.();
    };
    const onAbort = () => stop();
    if (o.timeoutMs && o.timeoutMs > 0) later(o.timeoutMs, () => { timedOut = true; stop(); });
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const forward = (line: string) => { events = events.then(() => o.onData?.(line)).catch(() => {}); };
    p.stdout!.setEncoding('utf8'); p.stderr!.setEncoding('utf8');
    p.stdout!.on('data', (d: string) => {
      stdout += d; pending += d;
      const lines = pending.split(/\r?\n/); pending = lines.pop() || '';
      for (const line of lines) forward(line);
    });
    p.stderr!.on('data', (d: string) => { stderr += d; });
    const finish = async (code: number | null) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
      if (pending) forward(pending);
      await events;
      resolve({ code, stdout, stderr, timedOut, killed });
    };
    p.on('error', e => { stderr += String(e); void finish(-1); });
    p.on('close', code => { void finish(code); });
    // 하위 프로세스가 출력 파이프를 붙잡고 있어도 직계 자식이 끝나면 정리한다.
    p.on('exit', code => later(killed ? 500 : 2000, () => { p.stdout?.destroy(); p.stderr?.destroy(); void finish(code); }));
    p.stdin!.on('error', () => {});
    p.stdin!.end(o.input ?? '');
    if (o.signal?.aborted) stop();
  });
}
