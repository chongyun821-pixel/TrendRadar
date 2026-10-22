import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { RadarReader } from './radar';
import { DATA_ROOT, safeError } from './config';
import { containedPath } from './store';
import { extractText } from './attachments';
import type { Report } from '../shared/types';

const id = z.string().uuid().parse(process.env.H5S_CHAT_ID);
// Do not initialize Store here: this child must never recover or modify active runs.
const db = new DatabaseSync(join(DATA_ROOT, 'h5s.sqlite'), { readOnly: true });
const radar = new RadarReader(), workspace = join(DATA_ROOT, 'workspaces', id);
const server = new McpServer({ name: 'h5s-workspace', version: '1.1.0' });
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const report = () => {
  const row = db.prepare('SELECT data FROM reports WHERE id=?').get(id) as { data: string } | undefined;
  if (!row) throw new Error('대화를 찾을 수 없습니다.');
  return JSON.parse(row.data) as Report;
};
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
function register(name: string, description: string, inputSchema: any, run: (input: any) => unknown) {
  server.registerTool(name, { description, inputSchema, annotations }, async (input: any) => {
    try { return result(await run(input)); }
    catch (e) { return { ...result({ error: safeError(e) }), isError: true }; }
  });
}
register('search_radar', '기존 procurement-radar DB의 조달 기록·보존 출처·보고서를 읽기 전용으로 검색합니다.', { query: z.string().max(500), kind: z.enum(['records', 'sources', 'reports']) }, ({ query, kind }) => radar.search(query, kind));
register('list_conversations', '기존 Radar 대화 목록을 읽습니다. 사용자가 연결할 대화를 지정할 때 사용합니다.', { query: z.string().default('') }, ({ query }) => radar.conversations(query));
register('read_conversation', '사용자가 참조한 기존 대화 원문과 자료 목록을 읽습니다. offset으로 다음 메시지를 이어 읽습니다.', { conversationId: z.string(), offset: z.number().int().min(0).default(0) }, async ({ conversationId, offset }) => {
  const context = await radar.conversation(conversationId);
  return { ...context, messages: context.messages.slice(offset, offset + 50), totalMessages: context.messages.length, nextOffset: offset + 50 < context.messages.length ? offset + 50 : null };
});
register('list_workspace', '현재 대화의 첨부자료와 원문 파일 목록을 조회합니다.', {}, () => {
  const walk = (dir: string, prefix = ''): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isSymbolicLink() ? [] : e.isDirectory() ? (e.name === 'runs' ? [] : walk(join(dir, e.name), prefix + e.name + '/')) : [prefix + e.name]);
  return { files: walk(workspace), attachments: report().attachments };
});
register('read_workspace', '현재 대화 폴더 안의 원문·추출 텍스트·과거 대화 맥락을 읽습니다. offset으로 긴 원문을 이어 읽습니다.', { path: z.string(), offset: z.number().int().min(0).default(0) }, ({ path, offset }) => {
  if (!/\.(md|txt|json|csv|tsv)$/i.test(path) || path.replaceAll('\\', '/').startsWith('runs/')) throw new Error('첨부자료나 대화 원문의 텍스트 경로를 지정해주세요.');
  const text = readFileSync(containedPath(workspace, path, true), 'utf8');
  return { path, text: text.slice(offset, offset + 24000), totalCharacters: text.length, nextOffset: offset + 24000 < text.length ? offset + 24000 : null };
});
register('read_radar_file', '연결한 기존 대화의 파일을 원본 해시 검증 후 읽습니다. 기존 파일을 수정하거나 복사하지 않습니다.', { artifactId: z.string() }, async ({ artifactId }) => {
  const current = report(); if (!current.radarConversationId) throw new Error('기존 대화를 먼저 연결해주세요.');
  const file = await radar.file(current.radarConversationId, artifactId), text = await extractText(file.bytes, file.name);
  return { name: file.name, hash: file.hash, text, ...(text.trim() ? {} : { note: '텍스트가 없는 파일입니다. 이미지로 첨부하거나 원문을 확인해주세요.' }) };
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void radar.close().finally(() => { db.close(); process.exit(0); }); });
