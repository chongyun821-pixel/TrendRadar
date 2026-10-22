import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store';
import { Agent } from '../server/agent';
import type { RadarReader } from '../server/radar';
import type { Run } from '../shared/types';
const roots: string[] = [], stores: Store[] = [];
afterEach(() => { stores.forEach(s => s.close()); stores.length = 0; roots.forEach(r => rmSync(r, { recursive: true, force: true })); roots.length = 0; });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'h5s-agent-test-')); roots.push(root);
  const store = new Store(root); stores.push(store);
  const report = store.create('도구 검증'), agent = new Agent(store, {} as RadarReader);
  const run: Run = { id: 'test-run', reportId: report.id, pageId: 'problem', action: 'draft', status: 'running', turnId: 'test-turn', text: '', items: {}, startedAt: new Date().toISOString() };
  agent.active.set(report.id, run); return { store, report, agent, run };
}
describe('agent mutation boundaries', () => {
  it('rejects late tool writes from an inactive or cancelled run', async () => {
    const { store, report, agent, run } = fixture();
    agent.active.delete(report.id);
    await expect(agent.callTool(run, 'h5s_update_draft', { pageId: 'problem', content: '늦은 응답', expectedVersion: 0, reason: '' })).rejects.toThrow(/활성/);
    expect(store.get(report.id).pages[0].content).toBe('');
  });
  it('rejects modification of a different page and of a draft during question preparation', async () => {
    const { agent, run } = fixture();
    await expect(agent.callTool(run, 'h5s_update_draft', { pageId: 'issue-tree', content: '이슈', expectedVersion: 0, reason: '' })).rejects.toThrow(/현재 요청/);
    run.action = 'questions';
    await expect(agent.callTool(run, 'h5s_update_draft', { pageId: 'problem', content: '답변 전 초안', expectedVersion: 0, reason: '' })).rejects.toThrow(/현재 요청/);
  });
  it('does not assign answers to regenerated questions whose meaning changed', async () => {
    const { store, report, agent, run } = fixture();
    store.change(report.id, r => { r.pages[0].answers = { 'problem-q1': '이전 질문의 답변' }; });
    await agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions: [{ id: 'problem-q1', label: '의미가 달라진 질문', hint: '', required: true, recommendedAnswer: '새 질문에 맞는 추천 답변' }] });
    expect(store.get(report.id).pages[0].answers).toEqual({ 'problem-q1': '새 질문에 맞는 추천 답변' });
    expect(store.get(report.id).pages[0].questionSource).toBe('codex');
  });
  it('requires prepared answers before the first AI draft', async () => {
    const { store, report, agent, run } = fixture();
    await expect(agent.callTool(run, 'h5s_update_draft', { pageId: 'problem', content: '성급한 초안', expectedVersion: 0, reason: '' })).rejects.toThrow(/질문/);
    expect(store.get(report.id).pages[0].content).toBe('');
  });
  it('persists recommendations as defaults and can draft without manual answers', async () => {
    const { store, report, agent, run } = fixture();
    const question = { id: 'goal', label: '무엇을 달성하나요?', hint: '목표를 확인하세요.', required: true, recommendedAnswer: '검토 시간을 단축한다. 목표 수치는 확인 필요.' };
    run.action = 'questions';
    await agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions: [question] });
    const page = store.get(report.id).pages[0];
    expect(page.answers.goal).toBe(question.recommendedAnswer);
    expect(page.questions[0].recommendedAnswer).toBe(question.recommendedAnswer);
    run.action = 'draft';
    await expect(agent.callTool(run, 'h5s_update_draft', { pageId: 'problem', content: '## 목표\n검토 시간을 단축한다. 목표 수치는 확인 필요.', expectedVersion: page.version, reason: '추천 답변 사용' })).resolves.toMatchObject({ applied: true });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const restored = new Store(store.root); stores.push(restored);
    expect(restored.get(report.id).pages[0].answers.goal).toBe(question.recommendedAnswer);
  });
  it('refreshes untouched defaults while preserving edited and deliberately cleared answers', async () => {
    const { store, report, agent, run } = fixture();
    const questions = ['edited', 'cleared', 'default'].map(id => ({ id, label: id, hint: '', required: false, recommendedAnswer: '첫 추천 답변' }));
    await agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions });
    const page = store.get(report.id).pages[0];
    store.updateDraft(report.id, 'problem', '', page.version, 'human', '', { ...page.answers, edited: '사용자가 직접 수정', cleared: '' });
    await agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions: questions.map(q => ({ ...q, recommendedAnswer: '새 추천 답변' })) });
    expect(store.get(report.id).pages[0].answers).toEqual({ edited: '사용자가 직접 수정', cleared: '', default: '새 추천 답변' });
  });
  it('fills legacy empty answers and accepts recommendations through the persisted old tool schema', async () => {
    const { store, report, agent, run } = fixture();
    const questions = store.get(report.id).pages[0].questions.slice(0, 2);
    store.change(report.id, r => { r.pages[0].answers = { [questions[0].id]: '', [questions[1].id]: '기존 사용자 입력' }; });
    await agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions: questions.map(q => ({ ...q, hint: '자료에 근거한 추천 답변. 미확인 사항은 추가 확인.' })) });
    const page = store.get(report.id).pages[0];
    expect(page.answers[questions[0].id]).toBe(page.questions[0].recommendedAnswer);
    expect(page.answers[questions[1].id]).toBe('기존 사용자 입력');
  });
  it('rejects questions that have no recommendation and leaves stored answers intact', async () => {
    const { store, report, agent, run } = fixture();
    await expect(agent.callTool(run, 'h5s_set_questions', { pageId: 'problem', questions: [{ id: 'q', label: '질문', hint: '', required: true }] })).rejects.toThrow(/추천 답변/);
    expect(store.get(report.id).pages[0].questionSource).toBe('template');
  });
});
