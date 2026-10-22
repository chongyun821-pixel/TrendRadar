import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store';
import { Agent } from '../server/agent';
import { RadarReader } from '../server/radar';
import { MODEL, EFFORT } from '../shared/types';

const root = resolve('.local/verification', `recommendations-${Date.now()}`);
mkdirSync(root, { recursive: true });
const store = new Store(root), radar = new RadarReader();
let agent = new Agent(store, radar);
const checks: string[] = [];
async function run(id: string, action: 'questions' | 'draft') {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { agent.off(id, changed); reject(new Error('Recommendation check timed out')); }, 600000);
    const changed = () => {
      if (agent.active.has(id)) return;
      clearTimeout(timer); agent.off(id, changed);
      const result = store.lastRun(id);
      result?.status === 'completed' ? resolve() : reject(new Error(result?.error || result?.status));
    };
    agent.on(id, changed);
    try { agent.start(id, 'problem', action); } catch (e) { clearTimeout(timer); agent.off(id, changed); reject(e); }
  });
}
try {
  const report = store.create('추천 답변 검증용 가상 교육 과제', '가상의 교육용 과제다. 내부 보고서 작성 절차를 개선하여 작성 시간을 줄이려 한다. 독자는 가상의 기획팀장이다. 내부 업무 절차만 분석하며 추가 예산과 외부 시스템 변경은 제외한다. 수치, 실제 담당자, 기한은 제공되지 않았다. 이 검증에서는 외부 검색이나 DB 조회 없이 이 맥락만 사용한다.');
  if (!process.argv.includes('--legacy-only')) {
  await run(report.id, 'questions');
  let page = store.get(report.id).pages[0];
  assert(page.questions.length >= 1 && page.questions.length <= 3);
  assert(page.questions.every(q => q.recommendedAnswer?.trim() && page.answers[q.id] === q.recommendedAnswer));
  checks.push('new report prepares only core questions with saved default answers'); console.log(checks.at(-1));
  await run(report.id, 'draft');
  page = store.get(report.id).pages[0];
  assert(page.content.trim()); assert(/확인|가정|미확인|제안/.test(page.content));
  checks.push('first draft is written from recommendations without manual answers, retaining uncertainty'); console.log(checks.at(-1));
  }

  // Start with the old question-tool schema, then resume it with the new Agent.
  const legacy = store.create('기존 보고서 추천 답변 호환 검증', report.context);
  const oldTools = [
    { name: 'h5s_get_report', description: '현재 보고서 조회', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'h5s_set_questions', description: '현재 단계 질문 준비', inputSchema: { type: 'object', properties: { pageId: { type: 'string' }, questions: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' }, required: { type: 'boolean' } }, required: ['id', 'label', 'hint', 'required'], additionalProperties: false } } }, required: ['pageId', 'questions'], additionalProperties: false } },
    { name: 'h5s_read_workspace', description: '자료 읽기', inputSchema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer' } }, required: ['path', 'offset'], additionalProperties: false } },
  ];
  await agent.bridge.start();
  const started = await agent.bridge.request('thread/start', { cwd: store.workspace(legacy.id), model: MODEL, sandbox: 'read-only', approvalPolicy: 'never', dynamicTools: oldTools.map(t => ({ ...t, type: 'function' })), config: { model_reasoning_effort: EFFORT } });
  // A newly started thread has no durable rollout until its first turn is written.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { agent.bridge.off('notification', completed); reject(new Error('Legacy seed turn timed out')); }, 180000);
    const completed = (e: any) => {
      if (e.method !== 'turn/completed' || e.params.threadId !== started.thread.id) return;
      clearTimeout(timer); agent.bridge.off('notification', completed);
      e.params.turn.status === 'completed' ? resolve() : reject(new Error('Legacy seed turn failed'));
    };
    agent.bridge.on('notification', completed);
    void agent.bridge.request('turn/start', { threadId: started.thread.id, model: MODEL, effort: EFFORT, input: [{ type: 'text', text: '호환성 검증용 세션이다. 아직 작업하지 말고 준비됨 한 마디만 답해줘.', text_elements: [] }] }).catch(e => { clearTimeout(timer); agent.bridge.off('notification', completed); reject(e); });
  });
  store.change(legacy.id, r => {
    r.threadId = started.thread.id;
    r.pages[0].questionSource = 'codex';
    r.pages[0].questions = [
      { id: 'legacy-purpose', label: '보고서의 목적은 무엇인가요?', hint: '목적을 적어주세요.', required: true },
      { id: 'legacy-scope', label: '검토 범위와 제약은 무엇인가요?', hint: '범위를 적어주세요.', required: false },
    ];
    r.pages[0].answers = { 'legacy-purpose': '기존에 직접 입력한 답변: 내부 보고서 검토 절차의 개선 방향을 정한다.' };
  });
  agent.bridge.stop(); agent = new Agent(store, radar);
  await run(legacy.id, 'questions');
  const resumed = store.get(legacy.id);
  assert.equal(resumed.threadId, started.thread.id);
  assert.deepEqual(resumed.pages[0].questions.map(q => q.id), ['legacy-purpose', 'legacy-scope']);
  assert(resumed.pages[0].questions.every(q => q.recommendedAnswer?.trim()));
  assert(resumed.pages[0].questions.every(q => q.recommendedAnswer!.length > 20));
  assert.equal(resumed.pages[0].answers['legacy-purpose'], '기존에 직접 입력한 답변: 내부 보고서 검토 절차의 개선 방향을 정한다.');
  assert.equal(resumed.pages[0].answers['legacy-scope'], resumed.pages[0].questions[1].recommendedAnswer);
  checks.push('old tool schema resumes the same thread, fills defaults, and preserves existing user input'); console.log(checks.at(-1));
  writeFileSync(join(root, 'receipt.json'), JSON.stringify({ ok: true, checks, root, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ok: true, checks, root }, null, 2));
} finally { agent.bridge.stop(); await radar.close(); store.close(); }
