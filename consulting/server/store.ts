import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyPages } from '../shared/templates';
import { type Report, type Run, PAGE_DEFS } from '../shared/types';
import { DATA_ROOT, RADAR_ROOT } from './config';
export class AppError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const now = () => new Date().toISOString();
export function assertStorageRoot(root: string, readOnlyRoot = RADAR_ROOT) {
  const canonical = (value: string) => {
    let ancestor = resolve(value); const suffix: string[] = [];
    while (!existsSync(ancestor)) { suffix.unshift(basename(ancestor)); const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
    return resolve(realpathSync(ancestor), ...suffix);
  };
  const rel = relative(canonical(readOnlyRoot), canonical(root));
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new AppError('H5S 저장 폴더는 읽기 전용으로 연결한 프로젝트 밖에 있어야 합니다.');
}
export function containedPath(root: string, name: string, mustExist = false): string {
  const base = resolve(root), path = resolve(base, name), rel = relative(base, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new AppError('허용되지 않은 파일 경로입니다.');
  if (mustExist) {
    if (!existsSync(path)) throw new AppError('파일을 찾을 수 없습니다.', 404);
    const real = relative(realpathSync(base), realpathSync(path));
    if (real.startsWith('..') || isAbsolute(real)) throw new AppError('작업 폴더 밖의 파일에 접근할 수 없습니다.');
  }
  return path;
}
export class Store {
  db: DatabaseSync;
  private fileOperations = new Map<string, number>();
  private deleted = new Set<string>();
  constructor(public root = DATA_ROOT) {
    assertStorageRoot(root);
    mkdirSync(root, { recursive: true });
    this.db = new DatabaseSync(join(root, 'h5s.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, report_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_report ON events(report_id,seq);`);
    for (const row of this.db.prepare('SELECT id,data FROM runs').all() as any[]) {
      const run: Run = JSON.parse(row.data);
      if (['starting', 'running', 'stopping'].includes(run.status)) {
        run.status = 'interrupted'; run.error = '서버가 재시작되었습니다. 같은 Codex 세션에서 다시 요청할 수 있습니다.'; this.saveRun(run);
      }
    }
  }
  workspace(id: string) {
    if (!/^[\da-f-]{36}$/i.test(id)) throw new AppError('잘못된 보고서 ID입니다.');
    this.get(id);
    const path = join(this.root, 'workspaces', id);
    mkdirSync(path, { recursive: true }); return path;
  }
  list(): Report[] { return (this.db.prepare('SELECT data FROM reports').all() as any[]).map(r => JSON.parse(r.data)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); }
  get(id: string): Report {
    const row = this.db.prepare('SELECT data FROM reports WHERE id=?').get(id) as any;
    if (!row) throw new AppError('보고서를 찾을 수 없습니다.', 404);
    return JSON.parse(row.data);
  }
  delete(id: string) {
    this.get(id);
    if (this.fileOperations.has(id)) throw new AppError('자료를 처리하고 있습니다. 잠시 후 대화를 삭제해주세요.', 409);
    if (!/^[\da-f-]{36}$/i.test(id)) throw new AppError('잘못된 보고서 ID입니다.');
    assertStorageRoot(this.root);
    const target = containedPath(this.root, `workspaces/${id}`, false);
    // Resolve existing links before recursive removal; the target must remain inside this store.
    if (existsSync(target)) containedPath(this.root, `workspaces/${id}`, true);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      rmSync(target, { recursive: true, force: true });
      this.db.prepare('DELETE FROM events WHERE report_id=?').run(id);
      this.db.prepare('DELETE FROM runs WHERE report_id=?').run(id);
      this.db.prepare('DELETE FROM reports WHERE id=?').run(id);
      this.db.exec('COMMIT');
      this.deleted.add(id);
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  async withFiles<T>(id: string, work: () => Promise<T>): Promise<T> {
    this.get(id);
    this.fileOperations.set(id, (this.fileOperations.get(id) || 0) + 1);
    try { return await work(); }
    finally {
      const count = (this.fileOperations.get(id) || 1) - 1;
      if (count) this.fileOperations.set(id, count); else this.fileOperations.delete(id);
    }
  }
  create(title: string, context = '', radarConversationId: string | null = null, mode: 'chat' | 'report' = 'report') {
    const report: Report = { id: randomUUID(), title: title || '새 대화', mode, context, radarConversationId, currentPage: 'problem', threadId: null, createdAt: now(), updatedAt: now(), pages: emptyPages(), messages: [], attachments: [], proposals: [] };
    this.save(report); return report;
  }
  createChat() { return this.create('새 대화', '', null, 'chat'); }
  promote(id: string, title: string, context: string) {
    const report = this.get(id);
    if (report.mode !== 'chat') return report;
    const root = this.workspace(id);
    writeFileSync(join(root, 'chat-handoff.json'), JSON.stringify({ title, context, messages: report.messages, attachments: report.attachments, radarConversationId: report.radarConversationId, createdAt: now() }, null, 2), 'utf8');
    report.mode = 'report'; report.reportOpenedAt = now(); report.title = title || report.title;
    report.context = context; report.threadId = null; report.currentPage = 'problem';
    this.save(report); return report;
  }
  save(report: Report) {
    if (this.deleted.has(report.id)) throw new AppError('삭제된 대화입니다.', 404);
    report.updatedAt = now();
    this.db.prepare('INSERT INTO reports VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(report.id, JSON.stringify(report));
    const root = this.workspace(report.id);
    writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    writeFileSync(join(root, 'conversation.json'), JSON.stringify({ id: report.id, title: report.title, context: report.context, mode: report.mode || 'report', messages: report.messages, attachments: report.attachments, radarConversationId: report.radarConversationId }, null, 2), 'utf8');
    writeFileSync(join(root, 'conversation.md'), report.messages.map(m => `## ${m.role === 'user' ? '사용자' : m.role === 'assistant' ? '도우미' : '안내'} · ${m.createdAt}\n\n${m.text}`).join('\n\n'), 'utf8');
    writeFileSync(join(root, 'report.md'), `# ${report.title}\n\n${report.pages.map(p => `# ${PAGE_DEFS.find(d => d.id === p.id)!.title}\n\n${p.content || '(작성 전)'}`).join('\n\n---\n\n')}`, 'utf8');
  }
  change(id: string, fn: (r: Report) => void) { const r = this.get(id); fn(r); this.save(r); return r; }
  updateDraft(id: string, pageId: string, content: string, expectedVersion: number, source: 'human' | 'codex', reason = '', answers?: Record<string, string>) {
    let conflict = false;
    const report = this.change(id, r => {
      const page = r.pages.find(p => p.id === pageId);
      if (!page) throw new AppError('산출물을 찾을 수 없습니다.');
      if (page.version !== expectedVersion) {
        if (source === 'human') throw new AppError('다른 탭에서 이 초안이 변경되었습니다. 최신 초안을 확인한 뒤 다시 저장해주세요.', 409);
        conflict = true;
        r.proposals.push({ id: randomUUID(), pageId, content, reason, baseVersion: expectedVersion, createdAt: now() });
        return;
      }
      const contentChanged = page.content !== content;
      const answersChanged = answers !== undefined && JSON.stringify(answers) !== JSON.stringify(page.answers);
      if (!contentChanged && !answersChanged) return;
      page.content = content; if (answers) page.answers = answers;
      page.version++; page.updatedAt = now();
      if (contentChanged) {
        page.status = content.trim() ? 'draft' : 'empty';
        const index = r.pages.indexOf(page);
        r.pages.slice(index + 1).forEach(p => { if (p.status === 'confirmed') p.status = 'draft'; });
      }
    });
    return { report, conflict, version: report.pages.find(p => p.id === pageId)!.version };
  }
  assertUnlocked(r: Report, pageId: string) {
    const index = r.pages.findIndex(p => p.id === pageId);
    if (index < 0) throw new AppError('잘못된 산출물입니다.');
    if (r.pages.slice(0, index).some(p => p.status !== 'confirmed')) throw new AppError('앞선 산출물을 확정한 뒤 이 단계를 작성해주세요.', 409);
  }
  confirm(id: string, pageId: string, version: number) {
    return this.change(id, r => {
      this.assertUnlocked(r, pageId);
      const page = r.pages.find(p => p.id === pageId)!;
      if (page.version !== version) throw new AppError('초안이 변경되었습니다. 최신 내용을 확인해주세요.', 409);
      if (!page.content.trim()) throw new AppError('내용을 작성한 뒤 확정해주세요.');
      page.status = 'confirmed';
      r.currentPage = r.pages[r.pages.indexOf(page) + 1]?.id || page.id;
    });
  }
  message(id: string, role: 'user' | 'assistant' | 'system', text: string, action?: string) {
    return this.change(id, r => r.messages.push({ id: randomUUID(), role, text, action, createdAt: now() }));
  }
  saveRun(run: Run) { this.get(run.reportId); this.db.prepare('INSERT INTO runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(run.id, run.reportId, JSON.stringify(run)); }
  lastRun(id: string): Run | null { const row = this.db.prepare('SELECT data FROM runs WHERE report_id=? ORDER BY rowid DESC LIMIT 1').get(id) as any; return row ? JSON.parse(row.data) : null; }
  event(id: string, event: unknown) { this.get(id); return Number(this.db.prepare('INSERT INTO events(report_id,data) VALUES (?,?)').run(id, JSON.stringify(event)).lastInsertRowid); }
  events(id: string, after = 0) { return this.db.prepare('SELECT seq,data FROM events WHERE report_id=? AND seq>? ORDER BY seq').all(id, after) as { seq: number; data: string }[]; }
  close() { this.db.close(); }
}
