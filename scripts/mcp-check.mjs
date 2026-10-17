// MCP 서버 점검: stdio로 띄워 도구 목록·호출 확인, 이어서 Streamable HTTP 확인
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const c = new Client({ name: 'check', version: '0' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [tsx, 'mcp/server.ts'] }));
const { tools } = await c.listTools();
console.log('stdio tools:', tools.map(t => t.name).join(', '));
const r = await c.callTool({ name: 'forecast', arguments: { country: '폴란드', system: '자주포' } });
console.log('forecast(폴란드, 자주포):', r.content[0].text.slice(0, 160).replace(/\s+/g, ' '));
const template = await c.callTool({ name: 'get_report_template', arguments: { format: 'pptx' } });
if (JSON.parse(template.content[0].text).templates[0].id !== 'ppt-country-v1') throw new Error('파워포인트 양식 조회 실패');
await c.close();

const port = 62399;
const p = spawn(process.execPath, [tsx, 'mcp/server.ts', '--http', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
await new Promise(res => p.stderr.on('data', d => String(d).includes('http') && res()));
const h = new Client({ name: 'check-http', version: '0' });
await h.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp`)));
console.log('http tools:', (await h.listTools()).tools.length);
const rep = await h.callTool({ name: 'forecast', arguments: { country: 'Canada', system: 'ssk' } });
console.log('forecast(Canada, ssk):', rep.content[0].text.slice(0, 160).replace(/\s+/g, ' '));
const query = await h.callTool({ name: 'query_procurement', arguments: { country: 'CAN', system: 'ssk' } });
if (!JSON.parse(query.content[0].text).records.length) throw new Error('새 조달 조회 도구 연결 실패');
await h.close(); p.kill();
