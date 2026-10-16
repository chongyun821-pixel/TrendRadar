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
import { searchPrograms, getLifespan, searchMro, getInventory, forecast, writeReport, listForecasts } from '../shared/tools';
import { RESEARCH_DEFS } from '../server/research';
import { runTool, newOut } from '../server/agent';
import { repository, PROJECT_ROOT, now } from '../server/store';
import { executions } from '../server/execution';
import { loadDevVars } from '../server/devvars';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let externalConversation: string | undefined;
async function scoped<T>(fn: () => T | Promise<T>): Promise<T> {
  const repo = repository();
  const inherited = process.env.RADAR_RUN_ID;
  const conversationId = process.env.RADAR_CONVERSATION_ID || (externalConversation ??= repo.createConversation('MCP 조사').id);
  repo.conversation(conversationId);
  const runId = inherited || randomUUID();
  if (!inherited) repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', runId, conversationId, 'mcp', 'running', now(), process.pid);
  try { return await executions.run({ conversationId, runId, repo, signal: new AbortController().signal, env: { ...process.env, ...loadDevVars(join(PROJECT_ROOT, '.secrets')) } }, fn); }
  finally { if (!inherited) repo.run("UPDATE runs SET status='completed',ended_at=? WHERE id=?", now(), runId); }
}

const SYS = '체계: 자주포|장갑차|대공미사일|다연장로켓|호위함|재래식 잠수함 (또는 sph|ifv|sam|mrl|frigate|ssk)';
const country = z.string().describe('국가명 (한글/영문/ISO3, 예: 폴란드, Poland, POL)');
const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 1) }] });

export function buildServer() {
  const s = new McpServer({ name: 'procurement-mcp', version: '0.1.0' });
  s.registerTool('search_programs', { description: '국가·체계별 보유 장비, 최근 계약, 사업 계획, 동향 (출처 포함)', inputSchema: { country: country.optional(), system: z.string().optional().describe(SYS) } },
    async a => json(searchPrograms(a)));
  s.registerTool('get_lifespan', { description: '체계별 설계 수명(추정 기본값)과 모델별 교체 시점', inputSchema: { system: z.string().optional().describe(SYS), model: z.string().optional().describe('모델명 일부, 예: K9, BMP') } },
    async a => json(getLifespan(a)));
  s.registerTool('search_mro', { description: '정비·성능개량·수명연장(MRO) 기록', inputSchema: { country: country.optional(), model: z.string().optional(), system: z.string().optional().describe(SYS) } },
    async a => json(searchMro(a)));
  s.registerTool('get_inventory', { description: '현재 보유 대수와 도입 연도 (추정 항목 표시)', inputSchema: { country: country.optional(), system: z.string().optional().describe(SYS) } },
    async a => json(getInventory(a)));
  s.registerTool('forecast', { description: '예상 교체 시기·수량·금액(억 원) 범위와 계산 과정. 결과는 예측', inputSchema: { country, system: z.string().optional().describe(SYS) } },
    async a => json(forecast(a)));
  s.registerTool('list_forecasts', { description: '히트맵용 예측 목록 (임박 순). update_heatmap 대체', inputSchema: { system: z.string().optional().describe(SYS), limit: z.number().int().min(1).max(100).optional() } },
    async a => json(listForecasts(a)));
  s.registerTool('write_report', { description: '국가 보고서(Markdown): 요약, 보유·도입 이력, 수명·MRO, 예측 근거, 경쟁·한화 기회, 출처', inputSchema: { country, system: z.string().optional().describe(SYS) } },
    async a => scoped(async () => { const out = newOut(); await runTool('write_report', a, out); return out.reports.length ? { content: [{ type: 'text' as const, text: out.reports[0] }] } : json({ error: '보고서 생성 실패' }); }));
  for (const def of RESEARCH_DEFS.filter(d => !d.name.startsWith('firecrawl_'))) {
    const shape = Object.fromEntries(Object.entries(def.properties).map(([key, p]) => {
      let schema: z.ZodTypeAny = p.type === 'integer' ? z.number().int() : p.type === 'boolean' ? z.boolean() : z.string();
      if (p.description) schema = schema.describe(p.description);
      return [key, def.required?.includes(key) ? schema : schema.optional()];
    }));
    s.registerTool(def.name, { description: def.description, inputSchema: shape }, async a => scoped(async () => json(await runTool(def.name, a, newOut()))));
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
