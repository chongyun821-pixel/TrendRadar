#!/usr/bin/env node
/**
 * procurement-mcp: 무기조달사업예상 데이터·예측 도구를 MCP로 제공
 *   stdio:            npx tsx mcp/server.ts
 *   Streamable HTTP:  npx tsx mcp/server.ts --http [--port 62357]   → http://localhost:62357/mcp
 * 화면 도구는 앱 서버(RADAR_APP_URL, 기본 http://127.0.0.1:62356)로 보내 열린 지도 탭에 바로 적용한다.
 * HTTP 요청에 X-Radar-Conversation-Id·X-Radar-Run-Id 헤더가 있으면(앱의 코덱스·그록 빌드 실행) 그 대화·실행에 결과를 저장하고,
 * 없으면(외부 클라이언트) 처음 호출에서 만든 외부 대화를 이어 쓴다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { z } from 'zod';
import { TOOL_DEFS } from '../server/agent';
import { executeTool } from '../server/tool-session';
import { storeFingerprint } from '../server/store';
import { appUrl } from '../server/screen-hub';
import { isLoopbackHost } from '../server/local-only';

let externalConversation: string | undefined;
const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 1) }] });

/** 실행 식별자: HTTP 헤더(요청별) → 환경 변수(stdio 자식) → 외부 대화 */
export interface RunIds { conversationId?: string; runId?: string }
export function buildServer(ids: RunIds = {}) {
  const s = new McpServer({ name: 'procurement-mcp', version: '0.2.0' });
  const compatibility = [{ name: 'forecast', description: 'calculate_forecast의 기존 호환 이름', properties: { country: { type: 'string' as const }, system: { type: 'string' as const } }, required: ['country'] }];
  for (const def of [...TOOL_DEFS, ...compatibility].filter(d => !d.name.startsWith('firecrawl_'))) {
    const shape = Object.fromEntries(Object.entries(def.properties).map(([key, p]) => {
      let schema: z.ZodTypeAny = p.type === 'integer' ? z.number().int() : p.type === 'boolean' ? z.boolean() : z.string();
      if (p.description) schema = schema.describe(p.description);
      return [key, def.required?.includes(key) ? schema : schema.optional()];
    }));
    s.registerTool(def.name, { description: def.description, inputSchema: shape }, async a => {
      const own = ids.conversationId || process.env.RADAR_CONVERSATION_ID;
      const result = await executeTool(def.name, a, own ? { conversationId: own, runId: ids.conversationId ? ids.runId : process.env.RADAR_RUN_ID } : { conversationId: externalConversation });
      if (!own) externalConversation ??= result.conversationId;
      return json(result.result);
    });
  }
  return s;
}

const argv = process.argv.slice(2);
if (argv.includes('--http')) {
  const pi = argv.indexOf('--port');
  const port = Number(pi >= 0 ? argv[pi + 1] : process.env.MCP_PORT || 62357);
  const uuid = z.string().uuid();
  const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
  createServer(async (req, res) => {
    // localhost Host만 받는다(DNS 리바인딩 차단)
    if (!isLoopbackHost(req.headers.host)) { res.writeHead(403).end('localhost 주소로 접속한 요청만 받습니다'); return; }
    // 앱이 이 서버를 쓸지 판단한다: 같은 저장소(지문)·같은 앱 서버로 화면 명령을 보내는지
    if (req.url === '/health' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: true, name: 'procurement-mcp', store: storeFingerprint(), app: appUrl() })); return; }
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end('not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    // 브라우저의 다른 사이트 요청(Origin이 다른 출처)은 받지 않는다(MCP Streamable HTTP 권고)
    const origin = req.headers.origin;
    if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { /* 잘못된 Origin */ } if (!ok) { res.writeHead(403).end('다른 출처의 요청은 받지 않습니다'); return; } }
    // 앱 실행 식별자(앱의 코덱스·그록 빌드가 실행마다 보낸다). 결과·근거·보고서 저장 대상으로만 쓴다
    const conversationId = header(req.headers['x-radar-conversation-id']), runId = header(req.headers['x-radar-run-id']);
    if ((conversationId && !uuid.safeParse(conversationId).success) || (runId && (!conversationId || !uuid.safeParse(runId).success))) { res.writeHead(400).end('X-Radar-Conversation-Id·X-Radar-Run-Id 형식이 올바르지 않습니다'); return; }
    try {
      let body = ''; for await (const c of req) body += c;
      const server = buildServer({ conversationId, runId });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch { if (!res.headersSent) res.writeHead(400).end('잘못된 MCP 요청'); }
  }).listen(port, '127.0.0.1', () => console.error(`procurement-mcp (Streamable HTTP) → http://localhost:${port}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
}
