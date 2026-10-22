import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { codexCommand, safeError, ROOT } from './config';
import { MODEL, EFFORT } from '../shared/types';
export type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string; code: number } };
export class CodexBridge extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 1;
  private pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private opening?: Promise<void>;
  connected = false;
  private generation = 0;
  constructor() { super(); }
  async start(): Promise<void> {
    if (this.connected) return;
    if (this.opening) return this.opening;
    this.opening = this.open().finally(() => { this.opening = undefined; });
    return this.opening;
  }
  private async open() {
    const spec = codexCommand();
    const generation = ++this.generation;
    const env = { ...process.env };
    // The CLI uses its own login. Server/database credentials are never passed through.
    for (const key of Object.keys(env)) if (/DATABASE_URL|SUPABASE.*KEY|RADAR_SUPABASE|RADAR_DATABASE/.test(key)) delete env[key];
    const child = this.child = spawn(spec.command, [...spec.args, 'app-server', '--listen', 'stdio://',
      '-c', `model="${MODEL}"`, '-c', `model_reasoning_effort="${EFFORT}"`,
      '-c', `mcp_servers.procurement={enabled=false,command=${JSON.stringify(process.execPath)}}`, '--disable', 'multi_agent'],
      { cwd: ROOT, windowsHide: true, shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: child.stdout }).on('line', line => {
      if (generation !== this.generation) return;
      try { this.receive(JSON.parse(line)); } catch (e) { this.emit('diagnostic', safeError(e)); }
    });
    // Stderr can contain account information; never forward it raw into browser logs.
    child.stderr.on('data', () => {});
    const fail = (e: Error) => {
      if (generation !== this.generation) return;
      this.connected = false; this.child = undefined;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e); }
      this.pending.clear(); this.emit('disconnect', e.message);
    };
    child.on('error', e => fail(new Error(safeError(e))));
    child.on('exit', code => fail(new Error(`Codex CLI 연결이 종료되었습니다 (${code ?? 'signal'}). 다시 요청하면 저장된 세션을 복원합니다.`)));
    try {
      await this.request('initialize', { clientInfo: { name: 'h5s_studio', title: 'H5S Studio', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
      this.connected = true;
    } catch (e) { child.kill(); throw e; }
  }
  private receive(message: Rpc) {
    if (message.id !== undefined && !message.method) {
      const p = this.pending.get(Number(message.id));
      if (p) { clearTimeout(p.timer); this.pending.delete(Number(message.id)); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
      return;
    }
    this.emit(message.id === undefined ? 'notification' : 'serverRequest', message);
  }
  private send(message: Rpc) {
    if (!this.child?.stdin.writable) throw new Error('Codex CLI가 연결되지 않았습니다.');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: any = {}, timeout = 45000): Promise<any> {
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} 연결 응답이 지연됩니다. 잠시 후 다시 시도해주세요.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  respond(id: number | string, result: any) { this.send({ id, result }); }
  async status() {
    let installed = false;
    try {
      codexCommand(); installed = true;
      await this.start();
      const account = await this.request('account/read', { refreshToken: false });
      const models = await this.request('model/list', { limit: 100 });
      const model = models.data?.find((m: any) => m.model === MODEL || m.id === MODEL);
      const modelAvailable = !!model && (model.supportedReasoningEfforts || []).some((e: any) => e.reasoningEffort === EFFORT);
      return { connected: true, installed, authenticated: !!account.account, modelAvailable,
        ...(!account.account ? { error: 'Codex CLI에서 codex login을 실행해주세요.' } : !modelAvailable ? { error: `${MODEL} · ${EFFORT} 사용 권한을 확인해주세요. 다른 모델로 자동 전환하지 않습니다.` } : {}) };
    } catch (e) { return { connected: false, installed, authenticated: false, modelAvailable: false, error: safeError(e) }; }
  }
  stop() { this.generation++; this.connected = false; this.child?.kill(); this.child = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('서버 종료')); } this.pending.clear(); }
}
