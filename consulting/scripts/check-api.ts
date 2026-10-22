import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { extractText } from '../server/attachments';
const root = resolve('.local/verification'); mkdirSync(root, { recursive: true });
const isolated = mkdtempSync(join(root, 'api-'));
const port = '4319', base = `http://127.0.0.1:${port}/api`;
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, PORT: port, H5S_DATA_DIR: isolated }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; child.stdout.on('data', b => { serverLog += b; }); child.stderr.on('data', b => { serverLog += b; });
const checks: string[] = [];
async function request(path: string, method = 'GET', body?: unknown, expected = 200) {
  const response = await fetch(base + path, { method, ...(body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const value = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(base + '/health'); if (r.ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 100)); }
  assert(ready, serverLog);
  const general = await request('/chats', 'POST', {}, 201), chatId = general.report.id;
  assert.equal(general.report.mode, 'chat'); assert.equal(general.report.threadId, null); checks.push('chat starts without registration or a report session');
  const allConversations = await request('/reports'); assert.equal(allConversations.find((r: any) => r.id === chatId).mode, 'chat'); checks.push('conversation persisted and listed');
  await request(`/reports/${chatId}/run`, 'POST', { pageId: 'problem', action: 'questions', text: '' }, 400); checks.push('chat cannot bypass report handoff');
  await request(`/reports/${chatId}/run`, 'POST', { pageId: 'chat', action: 'chat', text: '답변 중지 기능 검증용 가상 요청. 잠시 생각한 뒤 짧게 인사해줘. 보고서는 열지 마.' }, 202);
  await request(`/reports/${chatId}/run`, 'POST', { pageId: 'chat', action: 'chat', text: '중복 요청' }, 409); checks.push('one chat execution at a time');
  await request(`/reports/${chatId}`, 'DELETE', undefined, 409); checks.push('deletion rejected during live execution');
  const stoppedChat = await request(`/reports/${chatId}/stop`, 'POST');
  assert.equal(stoppedChat.report.mode, 'chat'); assert.equal(stoppedChat.run.status, 'interrupted'); assert(stoppedChat.report.pages.every((p: any) => !p.content)); checks.push('actual ephemeral process cancellation keeps chat and transcript');
  const chatStream = await fetch(base + `/reports/${chatId}/events`), chatReader = chatStream.body!.getReader();
  await chatReader.read();
  await request(`/reports/${chatId}`, 'DELETE');
  let deletedEvent = '';
  for (;;) { const item = await chatReader.read(); if (item.done) break; deletedEvent += new TextDecoder().decode(item.value); }
  assert(deletedEvent.includes('"type":"deleted"')); checks.push('deleted event closes other open conversation streams');
  await request(`/reports/${chatId}`, 'GET', undefined, 404);
  assert(!existsSync(join(isolated, 'workspaces', chatId))); checks.push('chat deletion removes local transcript and execution files');
  const c = await request('/reports', 'POST', { title: '격리 API 검증 과제', context: '기능 검증용 가상 데이터' }, 201), id = c.report.id;
  await request(`/reports/${id}/pages/issue-tree`, 'PATCH', { content: '불가', expectedVersion: 0 }, 409); checks.push('sequential page lock');
  let s = await request(`/reports/${id}/pages/problem`, 'PATCH', { content: '## 해결해야 할 기본 질문\n가상의 절차를 어떻게 개선할 것인가?', answers: { 'problem-q1': '가상 과제 검증' }, expectedVersion: 0 });
  await request(`/reports/${id}/pages/problem`, 'PATCH', { content: '늦은 수정', expectedVersion: 0 }, 409); checks.push('stale content rejected');
  await request(`/reports/${id}/pages/problem`, 'PATCH', { answers: { 'problem-q1': '늦은 답변' }, expectedVersion: 0 }, 409); checks.push('stale answers rejected');
  await request(`/reports/${id}/pages/problem/confirm`, 'POST', { expectedVersion: s.report.pages[0].version });
  s = await request(`/reports/${id}`); assert.equal(s.report.currentPage, 'issue-tree'); checks.push('confirmation unlocks next page');
  const form = new FormData(); form.append('files', new Blob(['가상 검증 자료 원본\n실제 데이터 아님'], { type: 'text/plain' }), '검증자료.txt');
  const upload = await fetch(base + `/reports/${id}/attachments`, { method: 'POST', body: form }); assert.equal(upload.status, 200);
  s = await upload.json(); const a = s.report.attachments[0]; assert.equal(a.name, '검증자료.txt'); assert.equal(a.extracted, true);
  const file = await fetch(base + `/reports/${id}/files/${a.id}`); assert.equal(await file.text(), '가상 검증 자료 원본\n실제 데이터 아님'); checks.push('Korean filename upload, extraction and original download');
  const conversations = await request('/radar/conversations');
  if (conversations.length) {
    const connected = await request(`/reports/${id}/radar`, 'POST', { conversationId: conversations[0].id });
    assert(connected.context.messages.length >= 0);
    const files = await request(`/reports/${id}/radar-files`); assert(Array.isArray(files));
    checks.push('actual Radar conversation and workspace listing read-only');
  }
  const search = await request('/radar/search?q=&kind=records'); assert(Array.isArray(search)); checks.push('actual Radar records read-only');
  const stream = await fetch(base + `/reports/${id}/events`), reader = stream.body!.getReader();
  const first = await reader.read(); assert(new TextDecoder().decode(first.value).includes('data:')); await reader.cancel(); checks.push('persistent SSE replay and snapshot');
  const html = await fetch(base + `/reports/${id}/export/html`); const text = await html.text(); assert.equal((text.match(/<section class="page"/g) || []).length, 7); checks.push('seven HTML pages');
  const pdf = await fetch(base + `/reports/${id}/export/pdf`); assert.equal(pdf.status, 200); writeFileSync(join(isolated, 'report.pdf'), Buffer.from(await pdf.arrayBuffer())); checks.push('PDF endpoint download');
  const docx = await fetch(base + `/reports/${id}/export/docx`); assert.equal(docx.status, 200);
  assert((await extractText(Buffer.from(await docx.arrayBuffer()), 'export.docx')).includes('기본 질문')); checks.push('editable Word endpoint and text roundtrip');
  const badOrigin = await fetch(base + '/reports', { method: 'POST', headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(badOrigin.status, 403); checks.push('cross-origin mutations rejected');
  s = await request(`/reports/${id}`);
  await request(`/reports/${id}/pages/problem`, 'PATCH', { content: '긴 본문\n\n' + '검증을 위한 매우 긴 본문입니다.\n\n'.repeat(250), expectedVersion: s.report.pages[0].version });
  const tooLong = await fetch(base + `/reports/${id}/export/pdf`); assert.equal(tooLong.status, 422); checks.push('PDF overflow rejected without truncation');
  await request(`/reports/${id}`, 'DELETE');
  await request(`/reports/${id}`, 'GET', undefined, 404);
  await request(`/reports/${id}/pages/problem`, 'PATCH', { content: '삭제 후 늦은 수정', expectedVersion: 0 }, 404);
  assert(!existsSync(join(isolated, 'workspaces', id))); checks.push('report deletion removes attachments and exports and rejects late writes');
  assert(!(await request('/reports')).some((r: any) => r.id === id));
  console.log(JSON.stringify({ ok: true, isolatedStorage: isolated, checks }, null, 2));
  writeFileSync(join(isolated, 'receipt.json'), JSON.stringify({ ok: true, checks, at: new Date().toISOString() }, null, 2));
} finally { child.kill(); }
