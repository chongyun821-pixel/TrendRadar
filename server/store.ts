import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, realpathSync, readdirSync, constants } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { useDataProvider } from '../shared/data';
import type { Seed } from '../shared/types';
import { loadDevVars } from './devvars';

export const PROJECT_ROOT = resolve(process.env.PROCUREMENT_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const vars = { ...loadDevVars(join(PROJECT_ROOT, '.secrets')), ...process.env };
export const STORAGE_ROOT = resolve(PROJECT_ROOT, vars.RADAR_STORAGE_DIR || '.local');
export const DB_PATH = resolve(PROJECT_ROOT, vars.RADAR_DB_PATH || join(STORAGE_ROOT, 'radar.sqlite'));
export const now = () => new Date().toISOString();
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export class Repository {
  db: DatabaseSync;
  private cached?: Seed;
  private cachedRevision = -1;
  constructor(public file: string, public storage: string, bootstrap = true) {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(storage, { recursive: true });
    if (!existsSync(file) && bootstrap) {
      try { copyFileSync(join(PROJECT_ROOT, 'db', 'initial.sqlite'), file, constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    this.db.exec(readFileSync(join(PROJECT_ROOT, 'db', 'schema.sql'), 'utf8'));
    this.transaction(() => {
      if (!this.all('PRAGMA table_info(runs)').some(c => c.name === 'result')) this.db.exec('ALTER TABLE runs ADD COLUMN result TEXT');
      if (!this.all('PRAGMA table_info(runs)').some(c => c.name === 'owner_pid')) this.db.exec('ALTER TABLE runs ADD COLUMN owner_pid INTEGER');
      this.run("INSERT OR IGNORE INTO schema_migrations VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    });
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_running_conversation ON runs(conversation_id) WHERE status IN ('running','stopping'); INSERT OR IGNORE INTO schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));");
  }
  all(sql: string, ...args: any[]): any[] { return this.db.prepare(sql).all(...args); }
  one(sql: string, ...args: any[]): any { return this.db.prepare(sql).get(...args); }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  transaction<T>(f: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = f(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  revision() { return Number(this.one("SELECT value FROM metadata WHERE key='revision'")?.value || 0); }
  data(): Seed {
    const revision = this.revision();
    if (this.cached && revision === this.cachedRevision) return this.cached;
    const entries = (table: string) => Object.fromEntries(this.all(`SELECT id, data FROM ${table}`).map(r => [r.id, JSON.parse(r.data)]));
    this.cached = { meta: JSON.parse(this.one("SELECT value FROM metadata WHERE key='meta'")?.value || '{}'), countries: entries('countries'), systems: entries('systems'), sources: entries('sources'), records: this.all('SELECT data FROM records ORDER BY id').map(r => JSON.parse(r.data)) } as Seed;
    this.cachedRevision = revision;
    return this.cached;
  }
  createConversation(title = '새 대화') {
    const id = randomUUID(), date = now();
    this.run('INSERT INTO conversations VALUES (?, ?, ?, ?)', id, title, date, date);
    for (const dir of ['attachments', 'sources', 'notes', 'analysis', 'reports', 'runs']) mkdirSync(join(this.workspace(id), dir), { recursive: true });
    return this.conversation(id);
  }
  workspace(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('잘못된 대화 ID');
    return join(this.storage, 'workspaces', id);
  }
  conversation(id: string) {
    const c = this.one('SELECT * FROM conversations WHERE id=?', id);
    if (!c) throw new Error('대화를 찾을 수 없습니다');
    return { ...c, workspace: this.workspace(id), messages: this.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid', id).map(m => ({ ...m, ...JSON.parse(m.payload) })), files: this.all('SELECT * FROM artifacts WHERE conversation_id=? ORDER BY rowid', id), runs: this.all('SELECT * FROM runs WHERE conversation_id=? ORDER BY rowid DESC', id) };
  }
  message(id: string, role: string, text: string, payload: unknown = {}) {
    this.conversation(id);
    const date = now();
    this.run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), id, role, text, JSON.stringify(payload), date);
    this.run('UPDATE conversations SET updated_at=? WHERE id=?', date, id);
    if (role === 'user') this.run("UPDATE conversations SET title=? WHERE id=? AND title='새 대화'", text.slice(0, 60), id);
  }
  deleteConversation(id: string) {
    this.conversation(id);
    this.transaction(() => {
      this.run('UPDATE artifacts SET conversation_id=NULL WHERE conversation_id=?', id);
      this.run('UPDATE reports SET conversation_id=NULL WHERE conversation_id=?', id);
      this.run('UPDATE runs SET conversation_id=NULL WHERE conversation_id=?', id);
      this.run('DELETE FROM conversations WHERE id=?', id);
    });
  }
  path(id: string, name: string, mustExist = false) {
    const root = this.workspace(id), target = resolve(root, name);
    const rel = relative(root, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('작업 폴더 밖의 경로');
    let ancestor = target;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (existsSync(root)) { const realRoot = realpathSync(root), real = realpathSync(ancestor); const realRel = relative(realRoot, real); if (realRel.startsWith('..') || isAbsolute(realRel)) throw new Error('작업 폴더 밖의 링크'); }
    if (mustExist && !existsSync(target)) throw new Error('파일 없음');
    return target;
  }
  artifact(id: string, name: string, content: string | Uint8Array, o: { runId?: string; mime?: string; kind?: string; url?: string; publishedAt?: string | null; status?: string; error?: string } = {}) {
    this.conversation(id);
    const digest = hash(content);
    const old = ['attachment','extracted','original','search'].includes(o.kind || '') ? this.one("SELECT * FROM artifacts WHERE conversation_id=? AND hash=? AND kind=? AND COALESCE(url,'')=?", id, digest, o.kind || 'note', o.url || '') : undefined;
    if (old) return old;
    const artifactId = randomUUID(), path = this.path(id, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    this.run('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', artifactId, id, o.runId || null, name, path, o.mime || 'text/plain', digest, o.kind || 'note', o.status || 'ok', o.url || null, o.publishedAt || null, now(), o.error || null);
    return this.one('SELECT * FROM artifacts WHERE id=?', artifactId);
  }
  files(id: string): string[] {
    const root = this.workspace(id);
    const walk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(x => !x.isSymbolicLink() && !x.name.startsWith('.')).flatMap(x => x.isDirectory() ? walk(join(dir, x.name)) : [relative(root, join(dir, x.name)).replaceAll('\\', '/')]) : [];
    return walk(root);
  }
  event(runId: string, name: string, data: unknown) { this.run('INSERT INTO events (run_id,name,data,created_at) VALUES (?,?,?,?)', runId, name, JSON.stringify(data), now()); }
  async backup(target: string) { mkdirSync(dirname(target), { recursive: true }); await backup(this.db, target); }
  close() { this.db.close(); }
}
const globalStore = globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> };
export function repository(): Repository {
  const stores = globalStore.__radarRepositories ??= new Map();
  const key = `${DB_PATH}:schema3`;
  if (!stores.has(key)) stores.set(key, new Repository(DB_PATH, STORAGE_ROOT));
  return stores.get(key)!;
}
useDataProvider(() => repository().data());
