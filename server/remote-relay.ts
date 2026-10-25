import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { executeTool } from './tool-session';
import { writeSetting, deleteSetting, CONNECTION_KEY, readSettings } from './settings-secrets';

export const RELAY_URL = () => (process.env.HORUS_RELAY_URL || 'https://horus-mcp.cwohk-mcp.workers.dev').replace(/\/$/, '');
type Link = { state: string; verifier: string; expires: number };
let link: Link | undefined;
let socket: WebSocket | undefined;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let stopped = false, status: any = { state: 'off', device: '', account: '', message: '' }, attempts = 0;
export const remoteStatus = () => ({ ...status });
export async function savedLinkState() {
  const text = await readSettings();
  const value = (name: string) => text.split(/\r?\n/).find(x => new RegExp(`^\\s*${name}\\s*=`).test(x))?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '') || '';
  return { hasKey: !!value('HORUS_CONNECTION_KEY'), device: value('HORUS_DEVICE_NAME') };
}
export async function retryRelay() {
  const saved = await savedLinkState();
  if (!saved.hasKey) return false;
  const text = await readSettings();
  const key = text.split(/\r?\n/).find(x => /^\s*HORUS_CONNECTION_KEY\s*=/.test(x))?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  if (key) startRelay(key, saved.device, remoteStatus().account);
  return !!key;
}
export function createLink(device: string, port: number) {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
  link = { state, verifier, expires: Date.now() + 600_000 };
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(`${RELAY_URL()}/app/link`);
  url.search = new URLSearchParams({ device, redirect_uri: `http://127.0.0.1:${port}/api/remote/callback`, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  status = { state: 'linking', device, account: '', message: '' };
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', url.toString()], { detached: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url.toString()], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* URL remains available to settings */ }
  return url.toString();
}
export async function completeLink(code: string, state: string) {
  const pending = link; link = undefined;
  if (!pending || pending.expires < Date.now() || pending.state.length !== state.length || !timingSafeEqual(Buffer.from(pending.state), Buffer.from(state))) throw new Error('?곌껐 ?붿껌??留뚮즺?섏뿀嫄곕굹 ?곹깭媛 ?쇱튂?섏? ?딆뒿?덈떎.');
  const response = await fetch(`${RELAY_URL()}/app/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, code_verifier: pending.verifier }) });
  const body = await response.json() as any;
  if (!response.ok || !body.key || !body.device) throw new Error(body.error || '湲곌린瑜??곌껐?섏? 紐삵뻽?듬땲??');
  await writeSetting(CONNECTION_KEY, body.key);
  status = { state: 'connecting', device: body.device, account: body.account || '', message: '' };
  startRelay(body.key, body.device, body.account || '');
  return body;
}
export function startRelay(key: string, device = '', account = '') {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  clearTimeout(reconnect);
  stopped = false; attempts = 0; status = { state: 'connecting', device, account, message: '' };
  const connect = () => {
    if (stopped) return;
    try {
      const url = new URL(RELAY_URL()); url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'; url.pathname = '/app/connect'; url.search = '';
      const ws = new WebSocket(url, ['horus-relay.v1', `bearer.${key}`]); socket = ws;
      let lastPong = Date.now(), heartbeat: ReturnType<typeof setInterval>;
      ws.addEventListener('open', () => { attempts = 0; status = { state: 'connected', device, account, message: '' }; heartbeat = setInterval(() => { if (Date.now() - lastPong > 45_000) ws.close(); else ws.send('{"type":"ping"}'); }, 15_000); });
      ws.addEventListener('message', event => { void (async () => { try { const m = JSON.parse(String(event.data)); if (m.type === 'hello') status = { state: 'connected', device: m.device || device, account: m.account || account, message: '' }; if (m.type === 'pong') lastPong = Date.now(); if (m.type === 'call' && typeof m.id === 'string') { const allowed = new Set(['get_app_context','set_map_state','write_report','set_app_view','set_chat_open','open_search','open_settings','list_conversations','search_conversations','read_conversation','switch_conversation','create_conversation','delete_conversation','set_chat_model','get_run_status','cancel_run']); if (!allowed.has(m.tool)) { ws.send(JSON.stringify({ type:'result', id:m.id, ok:false, error:'?덉슜?섏? ?딆? ?꾧뎄?낅땲??' })); return; } const controller = new AbortController(); let timedOut = false; let rejectTimeout!: (error: Error) => void; const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; }); const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(new Error('Tool execution timed out.')); }, Math.min(30_000, Math.max(1, Number(m.timeoutMs) || 30_000))); try { const conversationId = typeof m.conversationId === 'string' ? m.conversationId : undefined; const runId = typeof m.runId === 'string' ? m.runId : undefined; const result = await Promise.race([executeTool(m.tool, m.args || {}, { conversationId, runId, signal: controller.signal }), timeout]); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(timedOut ? { type:'result', id:m.id, ok:false, error:'Tool execution timed out.' } : { type:'result', id:m.id, ok:true, result:result.result })); } catch (e) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'result', id:m.id, ok:false, error:timedOut ? 'Tool execution timed out.' : e instanceof Error ? e.message : 'Tool execution failed.' })); } finally { clearTimeout(timer); } } } catch { /* malformed relay message */ } })(); });
      ws.addEventListener('close', event => { clearInterval(heartbeat); if (event.code === 4000) { stopped = true; status = { state:'off', device, account, message:'?ㅻⅨ ?곌껐???ъ슜 以묒엯?덈떎.' }; return; } if (event.code === 4003) { stopped = true; void deleteSetting(CONNECTION_KEY); status = { state:'login_required', device, account, message:'濡쒓렇?몄씠 ?꾩슂?⑸땲??' }; return; } schedule(); });
      ws.addEventListener('error', () => { status = { state:'error', device, account, message:'?먭꺽 ?곌껐??臾몄젣媛 ?덉뒿?덈떎.' }; });
    } catch { schedule(); }
  };
  const schedule = () => { if (stopped) return; const delay = Math.min(60_000, 1000 * 2 ** attempts++) * (0.8 + Math.random() * 0.4); status = { state:'connecting', device, account, message:'' }; reconnect = setTimeout(connect, delay); };
  connect();
}
export async function initializeRelay() { const text = await readSettings(); const key = text.split(/\r?\n/).find(x => /^\s*HORUS_CONNECTION_KEY\s*=/.test(x))?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g,''); const device = text.split(/\r?\n/).find(x => /^\s*HORUS_DEVICE_NAME\s*=/.test(x))?.split('=').slice(1).join('=').trim(); if (key) startRelay(key, device); }
export function unlinkRelay() { stopped = true; clearTimeout(reconnect); socket?.close(); void deleteSetting(CONNECTION_KEY); status = { state:'off', device:'', account:'', message:'' }; }
