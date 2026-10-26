import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { repository, PROJECT_ROOT, now } from '../server/store';
import { researchTool } from '../server/research';
import { executions } from '../server/execution';
import { app } from '../server/app';
import { validateAppContext } from '../server/app-context';
import { connectScreen, completeCommand, updateScreen } from '../server/screen-hub';
import { rememberRemote } from '../server/local-only';
import { getRequestListener } from '@hono/node-server';
import type { AddressInfo } from 'node:net';

const parsed = (r: any) => JSON.parse(r.content[0].text);
describe('MCP 실제 전송 통합 (외부 자료는 가상)', () => {
  it('Firecrawl Streamable HTTP 인증, 검색, 원문, 실패 기록', async () => {
    let fail = false;
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bearer test-firecrawl-key');
      let body = ''; for await (const chunk of req) body += chunk;
      const mcp = new McpServer({ name: 'fake-firecrawl', version: '1' });
      mcp.registerTool('firecrawl_search', { inputSchema: { query: z.string() } }, async a => ({ content: [{ type: 'text', text: JSON.stringify({ results: [{ url: 'https://example.org/test', title: a.query }] }) }] }));
      mcp.registerTool('firecrawl_scrape', { inputSchema: { url: z.string(), formats: z.array(z.string()) } }, async () => fail ? { isError: true, content: [{ type: 'text', text: 'upstream failed' }] } : { content: [{ type: 'text', text: JSON.stringify({ markdown: '가상 원문\n수량 12\n끝', metadata: { title: '가상 자료' } }) }] });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address() as { port: number };
    const repo = repository(), c = await repo.createConversation(), runId = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
    try {
      await executions.run({ repo, conversationId: c.id, runId, signal: new AbortController().signal, env: { FIRECRAWL_API_KEY: 'test-firecrawl-key', FIRECRAWL_MCP_URL: `http://127.0.0.1:${address.port}/mcp` } }, async () => {
        const search: any = await researchTool('firecrawl_search', { query: '가상 검색' });
        expect(search.kind).toBe('search');
        const original: any = await researchTool('firecrawl_scrape', { url: 'https://example.org/test' });
        expect(original.kind).toBe('original');
        expect(readFileSync(repo.path(c.id, original.filePath, true), 'utf8')).toBe('가상 원문\n수량 12\n끝');
        fail = true;
        expect(await researchTool('firecrawl_scrape', { url: 'https://example.org/failure' })).toHaveProperty('error');
        expect((await repo.one("SELECT count(*) AS n FROM artifacts WHERE conversation_id=? AND status='failed'", c.id)).n).toBe(1);
      });
    } finally { await repo.run("UPDATE runs SET status='completed' WHERE id=?", runId); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  });
  it('별도 MCP 프로세스에서 반영한 데이터, 예측, 6절 보고서를 웹 API에서 조회', async () => {
    const repo = repository(), c = await repo.createConversation(), runId = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test-mcp', 'running', now());
    const state = { screenId: randomUUID(), conversationId: c.id, model: 'codex', activeView: 'map', mode: 'sph', flat: false, focus: 'POL', filters: { system: 'sph' }, report: null, dataVersion: await repo.revision() };
    await validateAppContext(repo, state); await repo.event(runId, 'app.context', state);
    // 앱 서버(화면 허브)와 가짜 브라우저 탭: 별도 MCP 프로세스는 RADAR_APP_URL로 화면 명령을 보낸다
    const web = createServer(getRequestListener(req => { rememberRemote(req, '127.0.0.1'); return app.fetch(req); }));
    await new Promise<void>(r => web.listen(0, '127.0.0.1', r));
    const commands: any[] = [];
    const disconnect = connectScreen(state.screenId, (event, payload: any) => { if (event === 'command') { commands.push(payload.data); queueMicrotask(() => completeCommand(state.screenId, payload.id, { status: 'applied' })); } });
    updateScreen(state.screenId, { state: { ...state, focus: 'FIN' } as any });
    const client = new Client({ name: 'integration', version: '1' });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(PROJECT_ROOT, 'node_modules/tsx/dist/cli.mjs'), join(PROJECT_ROOT, 'mcp/server.ts')], cwd: PROJECT_ROOT, env: { NODE_ENV: 'test', PROCUREMENT_ROOT: PROJECT_ROOT, RADAR_DATABASE: 'sqlite', RADAR_DB_PATH: repo.file, RADAR_STORAGE_DIR: repo.storage, RADAR_CONVERSATION_ID: c.id, RADAR_RUN_ID: runId, RADAR_APP_URL: `http://127.0.0.1:${(web.address() as AddressInfo).port}` } }));
      const context = parsed(await client.callTool({ name: 'get_app_context', arguments: {} }));
      expect(context.request.focus).toBe('POL'); expect(context.current.state.focus).toBe('FIN');
      const brief = (await client.listTools()).tools.find(tool => tool.name === 'create_country_brief');
      expect(brief?.inputSchema).toMatchObject({ required: ['country', 'system'] });
      expect(parsed(await client.callTool({ name: 'create_country_brief', arguments: { country: '폴란드', system: '자주포' } }))).toMatchObject({ ok: true, status: 'applied', screenId: state.screenId });
      expect(commands.at(-1)).toEqual({ type: 'create_country_brief', country: 'POL', system: 'sph' });
      commands.length = 0;
      expect(parsed(await client.callTool({ name: 'set_map_state', arguments: { country: '독일' } }))).toMatchObject({ ok: true, status: 'applied', screenId: state.screenId });
      expect(commands).toEqual([{ type: 'set_map_state', country: 'DEU' }]);
      expect(parsed(await client.callTool({ name: 'find_country', arguments: { country: '독일' } })).matches[0]).toMatchObject({ country: 'DEU', registered: false });
      expect(parsed(await client.callTool({ name: 'add_country', arguments: { country: 'Germany' } }))).toMatchObject({ ok: true, created: true, country: 'DEU' });
      expect((await (await app.request('/api/data')).json()).countries.DEU).toMatchObject({ ko: '독일', flag: '🇩🇪' });
      expect(parsed(await client.callTool({ name: 'get_report_template', arguments: { format: 'pptx' } })).templates[0].id).toBe('ppt-country-v1');
      const prepared = parsed(await client.callTool({ name: 'research_procurement', arguments: { country: 'POL', system: 'sph' } }));
      const quote = '검증용 가상 계약 계획: 2031~2033년 10~12문';
      const source = parsed(await client.callTool({ name: 'save_source', arguments: { url: 'https://example.org/mcp-test', content: quote, kind: 'original' } }));
      const record = prepared.record;
      record.plan = { start: 2031, end: 2033, qty: [10,12], text: quote, src: ['integration-source'] }; record.src.push('integration-source');
      const p = { record, expectedVersion: prepared.expectedVersion, reason: '통합 검증', asOf: '2026-10-16', sources: { 'integration-source': { ...source, t: '가상 자료', u: 'https://example.org/mcp-test', y: 0 } }, evidence: [{ path: 'plan', sourceId: 'integration-source', quote }] };
      const normalized = parsed(await client.callTool({ name: 'normalize_procurement_data', arguments: { payload: JSON.stringify(p) } }));
      expect(normalized.ok).toBe(true);
      expect(parsed(await client.callTool({ name: 'validate_research', arguments: { payload: JSON.stringify(normalized.payload) } })).valid).toBe(true);
      expect(parsed(await client.callTool({ name: 'apply_research', arguments: { payload: JSON.stringify(normalized.payload) } })).ok).toBe(true);
      expect(parsed(await client.callTool({ name: 'query_procurement', arguments: { country: 'POL', system: 'sph' } })).records[0].plan.qty).toEqual([10,12]);
      const data = await (await app.request('/api/data')).json();
      expect(data.records.find((r: any) => r.id === record.id).plan.qty).toEqual([10,12]);
      const report = await (await app.request('/api/report?country=POL&system=sph')).text();
      expect(report).toContain('2031~2033'); expect(report).toContain('### 6. 출처'); expect(report).toContain(quote);
      const repeated = parsed(await client.callTool({ name: 'submit_research', arguments: { payload: JSON.stringify({ ...p, expectedVersion: prepared.expectedVersion + 1 }) } }));
      expect(repeated.unchanged).toBe(true);
      const raw = parsed(await client.callTool({ name: 'source_read', arguments: { sourceId: 'integration-source' } }));
      expect(raw.text).toBe(quote);
    } finally { await client.close(); disconnect(); web.closeAllConnections(); await new Promise<void>(r => web.close(() => r())); await repo.run("UPDATE runs SET status='completed' WHERE id=?", runId); }
  });
});
