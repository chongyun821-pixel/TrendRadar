import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { app } from '../server/app';
import { localOnly, rememberRemote, localServerUrl } from '../server/local-only';
import { screenSnapshot } from '../server/screen-hub';
import { repository, PROJECT_ROOT } from '../server/store';

const local = (path: string, init: RequestInit = {}, remote = '127.0.0.1') => {
  const request = new Request(`http://localhost${path}`, init);
  rememberRemote(request, remote);
  return app.fetch(request);
};
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 실제 HTTP 서버로 앱을 띄운다(SSE, 다른 프로세스 MCP용) */
const servers: Server[] = [];
async function serveApp() {
  const server = createServer(getRequestListener((req, { incoming }) => { rememberRemote(req, incoming.socket.remoteAddress); return app.fetch(req); }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
/** 가짜 브라우저 탭: SSE로 명령을 받아 reply 결과를 돌려준다 */
async function browserTab(base: string, reply: (data: any) => 'applied' | 'failed' | null = () => 'applied') {
  const id = randomUUID(), commands: any[] = [], controller = new AbortController();
  const response = await fetch(`${base}/api/screen/events?screen=${id}`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '', ready!: () => void;
  const isReady = new Promise<void>(r => (ready = r));
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === 'ready') ready();
          if (event === 'command' && data) {
            const command = JSON.parse(data); commands.push(command.data);
            const status = reply(command.data);
            if (status) await fetch(`${base}/api/screen/results/${command.id}`, json({ screenId: id, status, ...(status === 'failed' ? { detail: '가짜 실패' } : {}) }));
          }
        }
      }
    } catch { /* 닫힘 */ }
  })();
  await isReady;
  return { id, commands, close: () => controller.abort() };
}
const tabs: { close(): void }[] = [];
afterEach(async () => {
  for (const tab of tabs.splice(0)) tab.close();
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  for (let i = 0; i < 50 && screenSnapshot().available; i++) await new Promise(r => setTimeout(r, 10));
});

describe('화면 허브 로컬 전용 보호', () => {
  it('루프백 주소, localhost Host, 같은 출처만 받는다', async () => {
    expect(localOnly({ remote: '127.0.0.1', host: 'localhost:62356' })).toBeNull();
    expect(localOnly({ remote: '::1', host: '[::1]:62356', origin: 'http://[::1]:62356' })).toBeNull();
    expect(localOnly({ remote: '::ffff:127.0.0.1', host: '127.0.0.1:62356', origin: 'http://127.0.0.1:62356' })).toBeNull();
    expect(localOnly({ remote: '192.168.0.5', host: 'localhost:62356' })).toContain('localhost');
    expect(localOnly({ remote: '127.0.0.1', host: 'evil.example:62356' })).toContain('localhost 주소');
    expect(localOnly({ remote: '127.0.0.1', host: 'localhost:62356', origin: 'https://evil.example' })).toContain('다른 출처');
    expect(localOnly({ host: 'localhost' })).not.toBeNull(); // 접속 주소를 모르면(Workers 등) 거절
    expect(localServerUrl('0.0.0.0', 62356)).toBe('http://127.0.0.1:62356');
    expect(localServerUrl('::1', 1)).toBe('http://[::1]:1');
  });
  it('외부 주소, 다른 출처 요청은 화면 경로에서 403', async () => {
    expect((await local('/api/screen/context', {}, '10.0.0.2')).status).toBe(403);
    expect((await app.request('/api/screen/context')).status).toBe(403);
    expect((await local('/api/screen/command', { ...json({ data: { type: 'set_map_state', country: 'POL' } }), headers: { 'content-type': 'application/json', origin: 'https://evil.example' } })).status).toBe(403);
  });
});

describe('화면 명령 (DB 없이 SSE)', () => {
  it('연결된 화면이 없으면 바로 inactive', async () => {
    const started = Date.now();
    const r = await (await local('/api/screen/command', json({ data: { type: 'set_map_state', country: 'POL' } }))).json();
    expect(r).toMatchObject({ ok: false, status: 'inactive', message: expect.stringContaining('화면이 열려 있지 않음') });
    expect(Date.now() - started).toBeLessThan(500);
    expect(await (await local('/api/screen/context')).json()).toMatchObject({ available: false });
  });
  it('SSE로 명령을 밀어 넣고 적용, 실패, 시간 초과 결과를 동기로 돌려주며 가장 최근에 사용한 탭으로 보낸다', async () => {
    const base = await serveApp();
    const commands = (await repository().one('SELECT count(*) AS n FROM app_commands')).n;
    const first = await browserTab(base); tabs.push(first);
    const second = await browserTab(base, () => 'failed'); tabs.push(second);
    const send = async (data: any, timeoutMs?: number) => (await fetch(`${base}/api/screen/command`, json({ data, ...(timeoutMs ? { timeoutMs } : {}) }))).json();
    // 나중에 연결한 탭이 가장 최근
    expect(await send({ type: 'set_map_state', country: 'POL' })).toMatchObject({ ok: false, status: 'failed', detail: '가짜 실패', screenId: second.id });
    expect(await (await fetch(`${base}/api/screen/state`, json({ screenId: first.id, active: true }))).json()).toEqual({ ok: true, connected: true });
    expect(await send({ type: 'set_map_state', country: 'FIN', flat: true })).toMatchObject({ ok: true, status: 'applied', screenId: first.id });
    expect(first.commands).toEqual([{ type: 'set_map_state', country: 'FIN', flat: true }]);
    // 숨긴 탭은 뒤로 밀린다
    await fetch(`${base}/api/screen/state`, json({ screenId: first.id, hidden: true }));
    expect(await send({ type: 'set_map_state', country: 'JPN' })).toMatchObject({ screenId: second.id });
    second.close();
    for (let i = 0; i < 50 && screenSnapshot().screens > 1; i++) await new Promise(r => setTimeout(r, 10));
    expect(await send({ type: 'set_map_state', country: 'CAN' })).toMatchObject({ ok: true, status: 'applied', hidden: true, message: expect.stringContaining('백그라운드') });
    first.close();
    const silent = await browserTab(base, () => null); tabs.push(silent);
    const started = Date.now();
    expect(await send({ type: 'set_map_state', country: 'POL' }, 500)).toMatchObject({ ok: false, status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await (await fetch(`${base}/api/screen/results/${randomUUID()}`, json({ screenId: silent.id, status: 'applied' }))).json()).toEqual({ ok: true, accepted: false });
    expect((await repository().one('SELECT count(*) AS n FROM app_commands')).n).toBe(commands);
  });
  it('알 수 없는 명령, 잘못된 화면 ID는 거절한다', async () => {
    expect((await local('/api/screen/command', json({ data: { type: 'drop_tables' } }))).status).toBe(400);
    expect((await local('/api/screen/events?screen=abc')).status).toBe(400);
    expect(await (await local('/api/screen/state', json({ screenId: randomUUID(), hidden: true }))).json()).toEqual({ ok: true, connected: false });
  });
});

describe('HTTP MCP 서버(실행 ID 헤더)', () => {
  it('헤더의 대화, 실행에 저장하고 헤더가 없으면 외부 대화, 화면 명령은 앱 서버로 보낸다', async () => {
    const base = await serveApp(), repo = repository();
    const tab = await browserTab(base); tabs.push(tab);
    const port = 30000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [join(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs'), join(PROJECT_ROOT, 'mcp/server.ts'), '--http', '--port', String(port)], { cwd: PROJECT_ROOT, env: { ...process.env, RADAR_APP_URL: base }, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => { child.stderr!.on('data', d => { if (String(d).includes('Streamable HTTP')) resolve(); }); child.on('exit', reject); });
      const url = `http://127.0.0.1:${port}`;
      expect(await (await fetch(`${url}/health`)).json()).toMatchObject({ ok: true, name: 'procurement-mcp', app: base });
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { 'x-radar-conversation-id': 'nope' } })).status).toBe(400);
      expect((await fetch(`${url}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status).toBe(403);
      const c = await repo.createConversation(), runId = randomUUID();
      await repo.run("INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,'codex','running',?)", runId, c.id, new Date().toISOString());
      const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown>) => {
        const client = new Client({ name: 'screen-test', version: '1' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers } }));
        try { return JSON.parse((await client.callTool({ name, arguments: args }) as any).content[0].text); } finally { await client.close(); }
      };
      const saved = await call({ 'X-Radar-Conversation-Id': c.id, 'X-Radar-Run-Id': runId }, 'save_source', { url: 'https://example.org/header-test', content: '헤더 실행 원문', kind: 'original' });
      expect(await repo.one('SELECT conversation_id, run_id FROM artifacts WHERE hash=? AND name=?', saved.hash, saved.filePath)).toMatchObject({ conversation_id: c.id, run_id: runId });
      const external = await call({}, 'save_source', { url: 'https://example.org/external-test', content: '외부 클라이언트 원문', kind: 'original' });
      expect((await repo.one('SELECT conversation_id FROM artifacts WHERE hash=? AND name=?', external.hash, external.filePath)).conversation_id).not.toBe(c.id);
      expect(await call({}, 'set_map_state', { country: '폴란드', system: '자주포' })).toMatchObject({ ok: true, status: 'applied', screenId: tab.id });
      expect(tab.commands.at(-1)).toEqual({ type: 'set_map_state', country: 'POL', system: 'sph' });
      await repo.run("UPDATE runs SET status='completed' WHERE id=?", runId);
    } finally { child.kill(); }
  }, 30000);
});
