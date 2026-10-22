import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ReportState } from '../shared/types';

const base = 'http://127.0.0.1:4318/api';
const root = resolve('.local/verification', `case-live-${Date.now()}`);
mkdirSync(root, { recursive: true });
const checks: string[] = [];
async function request<T = any>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(base + path, { ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); assert(response.ok, JSON.stringify(data)); return data;
}
async function settle(id: string): Promise<ReportState> {
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const state = await request<ReportState>(`/reports/${id}`);
    if (state.run && !['starting', 'running', 'stopping'].includes(state.run.status)) {
      assert.equal(state.run.status, 'completed', state.run.error);
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  throw new Error('Case run exceeded 10 minutes');
}
const created = await request<ReportState>('/examples/h5s-world-bank', {}), id = created.report.id;
writeFileSync(join(root, 'created.json'), JSON.stringify({ id, root, at: new Date().toISOString() }, null, 2));
console.log('Example conversation: ' + id);
let state = await settle(id);
assert.equal(state.report.mode, 'chat'); assert.equal(state.run?.transport, 'exec');
assert(state.report.attachments.some(a => a.mime === 'image/jpeg'));
assert(state.report.messages.some(m => m.role === 'assistant' && m.text.trim()));
checks.push('photo-based scenario and source attachments open in normal ephemeral chat'); console.log(checks.at(-1));
await request(`/reports/${id}/run`, { pageId: 'chat', action: 'chat', text: '이 월드은행 교육 사례로 컨설팅 보고서 작성을 시작해줘. 기존 자료와 대화를 이어받고, 추천 답변을 먼저 채워줘. 교재에 없는 수치는 미확인으로 유지해줘.' });
state = await settle(id);
// The ephemeral reply is immediately followed by automatic question preparation on the server.
if (state.report.mode === 'chat' || state.report.pages[0].questionSource !== 'codex') {
  await new Promise(resolve => setTimeout(resolve, 1500)); state = await settle(id);
}
assert.equal(state.report.mode, 'report'); assert(state.report.threadId);
let page = state.report.pages[0];
assert.equal(page.questionSource, 'codex');
assert(page.questions.every(q => q.recommendedAnswer?.trim() && page.answers[q.id]?.trim()));
const threadId = state.report.threadId;
checks.push('report opens from chat with prepared recommended answers'); console.log(checks.at(-1));
await request(`/reports/${id}/run`, { pageId: 'problem', action: 'draft' }); state = await settle(id);
page = state.report.pages[0]; assert(page.content.length > 100); assert(/1\s*억|100\s*(?:million|백만)/i.test(page.content));
assert(/소매|국내/.test(page.content));
checks.push('problem definition is written from saved recommendations and source evidence'); console.log(checks.at(-1));
await request(`/reports/${id}/pages/problem/confirm`, { expectedVersion: page.version });
await request(`/reports/${id}/run`, { pageId: 'issue-tree', action: 'questions' }); state = await settle(id);
page = state.report.pages[1]; assert(page.questions.every(q => q.recommendedAnswer?.trim()));
await request(`/reports/${id}/run`, { pageId: 'issue-tree', action: 'draft' }); state = await settle(id);
assert(state.report.pages[1].content.trim()); assert.equal(state.report.threadId, threadId);
checks.push('issue tree is generated in the same report thread'); console.log(checks.at(-1));
const receipt = { ok: true, id, threadId, checks, testedPages: ['problem', 'issue-tree'], root, at: new Date().toISOString() };
writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
