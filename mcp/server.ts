#!/usr/bin/env node
/**
 * procurement-mcp: 무기조달사업예상 데이터·예측 도구를 MCP로 제공
 *   stdio:            npx tsx mcp/server.ts
 *   Streamable HTTP:  npx tsx mcp/server.ts --http [--port 62357]   → http://localhost:62357/mcp
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from 'node:http';
import { z } from 'zod';
import { TOOL_DEFS } from '../server/agent';
import { executeTool } from '../server/tool-session';

let externalConversation: string | undefined;
const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 1) }] });

export function buildServer() {
  const s = new McpServer({ name: 'procurement-mcp', version: '0.2.0' });
  const compatibility = [{ name: 'forecast', description: 'calculate_forecast의 기존 호환 이름', properties: { country: { type: 'string' as const }, system: { type: 'string' as const } }, required: ['country'] }];
  for (const def of [...TOOL_DEFS, ...compatibility].filter(d => !d.name.startsWith('firecrawl_'))) {
    const shape = Object.fromEntries(Object.entries(def.properties).map(([key, p]) => {
      let schema: z.ZodTypeAny = p.type === 'integer' ? z.number().int() : p.type === 'boolean' ? z.boolean() : z.string();
      if (p.description) schema = schema.describe(p.description);
      return [key, def.required?.includes(key) ? schema : schema.optional()];
    }));
    s.registerTool(def.name, { description: def.description, inputSchema: shape }, async a => {
      const result = await executeTool(def.name, a, { conversationId: process.env.RADAR_CONVERSATION_ID || externalConversation, runId: process.env.RADAR_RUN_ID });
      externalConversation ??= result.conversationId;
      return json(result.result);
    });
  }
  return s;
}

const argv = process.argv.slice(2);
if (argv.includes('--http')) {
  const pi = argv.indexOf('--port');
  const port = Number(pi >= 0 ? argv[pi + 1] : process.env.MCP_PORT || 62357);
  createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end('not found'); return; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    // 브라우저의 다른 사이트 요청(Origin이 다른 출처)은 받지 않는다(MCP Streamable HTTP 권고)
    const origin = req.headers.origin;
    if (origin) { let ok = false; try { ok = new URL(origin).host === req.headers.host; } catch { /* 잘못된 Origin */ } if (!ok) { res.writeHead(403).end('다른 출처의 요청은 받지 않습니다'); return; } }
    try {
      let body = ''; for await (const c of req) body += c;
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch { if (!res.headersSent) res.writeHead(400).end('잘못된 MCP 요청'); }
  }).listen(port, '127.0.0.1', () => console.error(`procurement-mcp (Streamable HTTP) → http://localhost:${port}/mcp`));
} else {
  await buildServer().connect(new StdioServerTransport());
}
