// Integration fixture: models and the authored Word file are simulated; MCP preparation and publication are real.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { zipSync, strToU8 } from 'fflate';
import { mkdirSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2), chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
const config = args.filter((_, index) => args[index - 1] === '-c');
const url = JSON.parse(config.find(value => value.startsWith('mcp_servers.procurement_radar.url=')).split('=').slice(1).join('='));
const headersConfig = config.find(value => value.startsWith('mcp_servers.procurement_radar.http_headers=')) ?? '';
const headers = Object.fromEntries([...headersConfig.matchAll(/"([^"]+)"\s*=\s*"([^"]+)"/g)].map(match => [match[1], match[2]]));
const client = new Client({ name: 'fake-brief-cli', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
const call = async (name, arguments_) => {
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', tool: name } }) + '\n');
  const response = await client.callTool({ name, arguments: arguments_ });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
};
try {
  const match = /대상은 국가 ([A-Z]{3}), 무기체계 ([a-z]+)입니다/.exec(prompt.slice(prompt.lastIndexOf('사용자: ')));
  if (!match) throw new Error('요청 범위 누락');
  const country = match[1], system = match[2];
  await call('get_country_data_status', { country, system });
  await call('research_procurement', { country, system });
  const packet = await call('prepare_report', { country, system, templateId: 'word-map-brief-v1', basis: 'latest' });
  mkdirSync('reports', { recursive: true });
  const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>자동화 검증용 모의 요약 보고서</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>';
  writeFileSync('reports/summary-check.docx', zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(xml),
  }));
  const file = await call('publish_artifact', { path: 'reports/summary-check.docx', preparationId: packet.id, review: JSON.stringify({ content: true, layout: true, notes: '자동화 테스트의 모의 검수 결과. 실제 조사와 문서 렌더링을 수행한 결과가 아니다.' }) });
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `[모의 Word 요약 보고서](${file.url})` } }) + '\n');
} finally { await client.close(); }
