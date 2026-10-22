import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, containedPath, assertStorageRoot } from '../server/store';
const stores: Store[] = [], roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), 'h5s-test-')); roots.push(root); const store = new Store(root); stores.push(store); return store; }
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
describe('H5S versioned editing and sequential workflow', () => {
  it('preserves human edits when a delayed AI write arrives, persisting the suggestion instead', () => {
    const store = fixture(), r = store.create('충돌 검증');
    const human = store.updateDraft(r.id, 'problem', '사용자가 편집한 본문', 0, 'human');
    expect(human.version).toBe(1);
    const ai = store.updateDraft(r.id, 'problem', '늦게 도착한 AI 본문', 0, 'codex', '보완');
    expect(ai.conflict).toBe(true);
    expect(ai.report.pages[0].content).toBe('사용자가 편집한 본문');
    expect(ai.report.proposals[0].content).toBe('늦게 도착한 AI 본문');
    expect(() => store.updateDraft(r.id, 'problem', '다른 탭의 본문', 0, 'human')).toThrow(/다른 탭/);
    expect(store.get(r.id).pages[0].content).toBe('사용자가 편집한 본문');
  });
  it('locks later outputs until predecessors are confirmed and invalidates confirmations after earlier edits', () => {
    const store = fixture(), r = store.create('단계 검증');
    expect(() => store.assertUnlocked(r, 'issue-tree')).toThrow(/앞선/);
    expect(() => store.confirm(r.id, 'problem', 0)).toThrow(/내용/);
    store.updateDraft(r.id, 'problem', '문제 정의', 0, 'human');
    store.confirm(r.id, 'problem', 1);
    expect(store.get(r.id).currentPage).toBe('issue-tree');
    store.updateDraft(r.id, 'issue-tree', '- 주요 이슈', 0, 'human'); store.confirm(r.id, 'issue-tree', 1);
    store.updateDraft(r.id, 'problem', '변경된 문제 정의', 1, 'human');
    expect(store.get(r.id).pages[1].status).toBe('draft');
    expect(store.get(r.id).pages[1].content).toBe('- 주요 이슈');
    expect(() => store.assertUnlocked(store.get(r.id), 'hypothesis')).toThrow(/앞선/);
  });
  it('keeps the same Codex thread across repository reopen and marks in-flight work interrupted', () => {
    const store = fixture(), r = store.create('재시작 검증');
    store.change(r.id, r => { r.threadId = 'test-persistent-thread'; });
    store.saveRun({ id: 'test-run', reportId: r.id, pageId: 'problem', action: 'draft', status: 'running', turnId: 'test-turn', text: '부분 응답', items: {}, startedAt: new Date().toISOString() });
    store.close(); stores.splice(stores.indexOf(store), 1);
    const restored = new Store(store.root); stores.push(restored);
    expect(restored.get(r.id).threadId).toBe('test-persistent-thread');
    expect(restored.lastRun(r.id)?.status).toBe('interrupted');
    expect(restored.lastRun(r.id)?.text).toBe('부분 응답');
  });
});
describe('workspace file boundaries', () => {
  it('refuses storage paths inside a connected read-only project before creating files', () => {
    const store = fixture(), protectedRoot = join(store.root, 'protected-project'); mkdirSync(protectedRoot);
    expect(() => assertStorageRoot(join(protectedRoot, 'nested', 'h5s'), protectedRoot)).toThrow(/밖/);
    expect(() => assertStorageRoot(protectedRoot, protectedRoot)).toThrow(/밖/);
    expect(() => assertStorageRoot(join(store.root, 'own-h5s'), protectedRoot)).not.toThrow();
  });
  it('rejects traversal and absolute paths outside the session workspace', () => {
    const store = fixture(), r = store.create('경로 검증'), workspace = store.workspace(r.id);
    expect(() => containedPath(workspace, '../outside.txt')).toThrow(/경로/);
    expect(() => containedPath(workspace, store.root)).toThrow(/경로/);
    mkdirSync(join(workspace, 'attachments')); writeFileSync(join(workspace, 'attachments', 'inside.txt'), '본문');
    expect(containedPath(workspace, 'attachments/inside.txt', true)).toBe(join(workspace, 'attachments', 'inside.txt'));
  });
});
describe('conversation deletion', () => {
  it('removes only the selected conversation and its files, executions and events', () => {
    const store = fixture(), removed = store.createChat(), kept = store.createChat();
    store.message(removed.id, 'user', '삭제할 대화');
    const workspace = store.workspace(removed.id);
    mkdirSync(join(workspace, 'attachments')); writeFileSync(join(workspace, 'attachments', 'test.txt'), '삭제할 첨부자료');
    store.saveRun({ id: 'deletion-test-run', reportId: removed.id, pageId: 'chat', action: 'chat', status: 'completed', turnId: null, text: '', items: {}, startedAt: new Date().toISOString() });
    store.event(removed.id, { type: 'state', data: '삭제할 이벤트' });
    store.event(kept.id, { type: 'state', data: '보존할 이벤트' });
    store.delete(removed.id);
    expect(() => store.get(removed.id)).toThrow(/찾을 수/);
    expect(store.lastRun(removed.id)).toBeNull(); expect(store.events(removed.id)).toEqual([]);
    expect(existsSync(workspace)).toBe(false);
    expect(store.get(kept.id).id).toBe(kept.id); expect(store.events(kept.id)).toHaveLength(1);
    expect(() => store.workspace(removed.id)).toThrow(/찾을 수/);
    expect(() => store.save(removed)).toThrow(/삭제된/);
    expect(existsSync(workspace)).toBe(false);
  });
  it('rejects deletion while asynchronous attachment or export writes are pending', async () => {
    const store = fixture(), report = store.createChat();
    let finish!: () => void;
    const work = store.withFiles(report.id, () => new Promise<void>(resolve => { finish = resolve; }));
    expect(() => store.delete(report.id)).toThrow(/자료를 처리/);
    finish(); await work; store.delete(report.id);
    expect(() => store.get(report.id)).toThrow(/찾을 수/);
  });
  it('does not traverse a redirected workspace into an unrelated folder', () => {
    const store = fixture(), report = store.createChat(), target = store.workspace(report.id);
    const outside = mkdtempSync(join(tmpdir(), 'h5s-delete-protected-')); roots.push(outside);
    writeFileSync(join(outside, 'keep.txt'), '원본 유지');
    rmSync(target, { recursive: true, force: true });
    symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.delete(report.id)).toThrow(/작업 폴더 밖/);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('원본 유지');
    expect(store.get(report.id).id).toBe(report.id);
  });
});
