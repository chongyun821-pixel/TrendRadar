import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, existsSync, copyFileSync, readFileSync, writeFileSync, realpathSync, readdirSync, constants } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { useDataProvider } from '../shared/data';
import { SYSTEM_KEYS, type Seed } from '../shared/types';
import { loadDevVars } from './devvars';
import { AsyncLocalStorage } from 'node:async_hooks';
import { databaseClient, DB_CONNECTIONS, postgresQuery, SupabaseFiles, type SupabaseConfig } from './supabase';

export const PROJECT_ROOT = resolve(process.env.PROCUREMENT_ROOT || fileURLToPath(new URL('..', import.meta.url)));
const vars = { ...loadDevVars(join(PROJECT_ROOT, '.secrets')), ...process.env };
export const STORAGE_ROOT = resolve(PROJECT_ROOT, vars.RADAR_STORAGE_DIR || '.local');
export const DB_PATH = resolve(PROJECT_ROOT, vars.RADAR_DB_PATH || join(STORAGE_ROOT, 'radar.sqlite'));
export const now = () => new Date().toISOString();
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
// SQLite는 격리 테스트·명시적 이전 원본에만 사용한다. 앱과 MCP의 운영 DB는 Supabase다.
export const DATABASE_KIND = process.env.NODE_ENV === 'test' && process.env.RADAR_DATABASE === 'sqlite' ? 'sqlite' : 'supabase';
export function supabaseConfig(): SupabaseConfig {
  const config = { ...process.env, ...loadDevVars(join(PROJECT_ROOT, '.secrets')) };
  return { databaseUrl: config.DATABASE_URL || '', url: config.SUPABASE_URL || '', secretKey: config.SUPABASE_SECRET_KEY || '', bucket: config.SUPABASE_STORAGE_BUCKET || 'trendradar-private', schema: process.env.RADAR_PG_SCHEMA || config.RADAR_PG_SCHEMA || 'trendradar' };
}
/** 배포한 SQL 변경 이력. 표 구조는 schema 파일에도 있어 새 스키마에 바로 생성되고, 자료 변경은 버전별로 한 번만 적용한다. */
/** 같은 저장소(DB·작업 폴더)를 쓰는 서버인지 비교하는 지문. 비밀값은 해시 안에만 들어가고 그대로 내보내지 않는다 */
export function storeFingerprint() {
  const db = DATABASE_KIND === 'sqlite' ? DB_PATH : (({ url, schema }) => `${url}#${schema}`)(supabaseConfig());
  return hash(JSON.stringify([DATABASE_KIND, db, STORAGE_ROOT])).slice(0, 16);
}
export const MIGRATIONS = [{ version: 4, name: '데이터 수집 테이블·IFV', sqlite: '004_data_collection.sql', postgres: '004_data_collection.postgres.sql' }, { version: 5, name: '수집 작업 기록', sqlite: '005_ingest_runs.sql', postgres: '005_ingest_runs.postgres.sql' }, { version: 6, name: '대화 조회 색인', sqlite: '006_conversation_indexes.sql', postgres: '006_conversation_indexes.postgres.sql' }, { version: 7, name: '등급 표기 변경', sqlite: '007_tier_labels.sql', postgres: '007_tier_labels.postgres.sql' }, { version: 8, name: '레이저대공무기 모드 삭제', sqlite: '008_remove_laser.sql', postgres: '008_remove_laser.postgres.sql' }, { version: 9, name: '진행 중 사업(캐나다 HIMARS·CPSP)', sqlite: '009_programs.sql', postgres: '009_programs.postgres.sql' }] as const;
export class Repository {
  db!: DatabaseSync;
  private cached?: Seed;
  private cachedRevision = -1;
  private sql?: ReturnType<typeof databaseClient>;
  private cloud?: SupabaseFiles;
  private transactionState = new AsyncLocalStorage<{ active: boolean; sql?: any; queue?: Promise<unknown> }>();
  private queue: Promise<unknown> = Promise.resolve();
  // Supabase 트랜잭션 풀러(6543)는 한 연결에 여러 쿼리를 겹쳐 보내면(파이프라인) 응답이 멈춘다.
  // 그래서 동시에 DB를 쓰는 작업을 연결 수(DB_CONNECTIONS)까지로 제한하고, 트랜잭션 안의 쿼리는 하나씩 보낸다.
  private slots = DB_CONNECTIONS;
  private waiting: (() => void)[] = [];
  readonly kind: 'sqlite' | 'supabase';
  readonly ready: Promise<void>;
  constructor(public file: string, public storage: string, bootstrap = true, config?: SupabaseConfig) {
    this.kind = config ? 'supabase' : 'sqlite';
    if (config) {
      mkdirSync(storage, { recursive: true });
      this.sql = databaseClient(config);
      this.cloud = new SupabaseFiles(config);
      this.ready = (async () => {
        await this.sql!.unsafe(`CREATE SCHEMA IF NOT EXISTS "${config.schema}"`);
        await this.sql!.unsafe(`REVOKE ALL ON SCHEMA "${config.schema}" FROM PUBLIC`);
        await this.sql!.unsafe(readFileSync(join(PROJECT_ROOT, 'db', 'schema.postgres.sql'), 'utf8'));
      })();
      return;
    }
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(storage, { recursive: true });
    if (!existsSync(file) && bootstrap) {
      try { copyFileSync(join(PROJECT_ROOT, 'db', 'initial.sqlite'), file, constants.COPYFILE_EXCL); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON;');
    this.db.exec(readFileSync(join(PROJECT_ROOT, 'db', 'schema.sql'), 'utf8'));
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(c => c.name === 'result')) this.db.exec('ALTER TABLE runs ADD COLUMN result TEXT');
    if (!this.db.prepare('PRAGMA table_info(runs)').all().some(c => c.name === 'owner_pid')) this.db.exec('ALTER TABLE runs ADD COLUMN owner_pid INTEGER');
    this.db.exec("INSERT OR IGNORE INTO schema_migrations VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_running_conversation ON runs(conversation_id) WHERE status IN ('running','stopping'); INSERT OR IGNORE INTO schema_migrations VALUES (2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));");
    // 격리 테스트·이전 원본용 SQLite에만 자동 적용한다. Supabase는 `npm run supabase -- schema`로 명시 적용한다.
    for (const m of MIGRATIONS) {
      if (this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(m.version)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try { this.db.exec(readFileSync(join(PROJECT_ROOT, 'db', 'migrations', m.sqlite), 'utf8')); this.db.exec('COMMIT'); }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    }
    this.ready = Promise.resolve();
  }
  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.slots > 0) this.slots--; else await new Promise<void>(r => this.waiting.push(r));
    try { return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.slots++; }
  }
  private exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  async all(query: string, ...args: any[]): Promise<any[]> {
    await this.ready;
    if (this.sql) {
      const tx = this.transactionState.getStore(), text = postgresQuery(query);
      let rows: any[];
      if (tx?.active) {
        const result = (tx.queue ?? Promise.resolve()).then(() => tx.sql.unsafe(text, args));
        tx.queue = result.catch(() => {});
        rows = await result;
      } else rows = await this.withSlot(() => this.sql!.unsafe(text, args));
      return rows.map((row: any) => {
        const result = { ...row }; delete result.row_order;
        if (typeof result.path === 'string' && result.path.startsWith('workspaces/')) result.path = this.localPath(result.path);
        return result;
      });
    }
    const read = () => this.db.prepare(query).all(...args);
    return this.transactionState.getStore()?.active ? read() : this.exclusive(read);
  }
  async one(sql: string, ...args: any[]): Promise<any> { return (await this.all(sql, ...args))[0]; }
  async run(query: string, ...args: any[]) {
    await this.ready;
    if (/^(UPDATE|INSERT|DELETE)\b/i.test(query) && /\b(metadata|countries|systems|sources|records)\b/i.test(query)) this.cachedRevision = -1;
    if (this.sql) return this.all(query, ...args);
    const write = () => this.db.prepare(query).run(...args);
    return this.transactionState.getStore()?.active ? write() : this.exclusive(write);
  }
  async transaction<T>(f: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.ready;
    if (this.transactionState.getStore()?.active) throw new Error('중첩 트랜잭션은 지원하지 않습니다');
    if (this.sql) {
      try {
        return await this.withSlot(() => this.sql!.begin('isolation level serializable', async sql => {
          const state: { active: boolean; sql: any; queue?: Promise<unknown> } = { active: true, sql };
          try { const result = await this.transactionState.run(state, f); signal?.throwIfAborted(); return result; }
          finally { state.active = false; }
        })) as T;
      } catch (e: any) {
        this.cachedRevision = -1;
        if (e.code === '40001' || e.code === '40P01') throw new Error('데이터 버전 충돌: 재조회 후 제출');
        throw e;
      }
    }
    return this.exclusive(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      const state = { active: true };
      try { const result = await this.transactionState.run(state, f); signal?.throwIfAborted(); this.db.exec('COMMIT'); return result; }
      catch (e) { this.db.exec('ROLLBACK'); this.cachedRevision = -1; throw e; }
      finally { state.active = false; }
    });
  }
  async schemaVersions(): Promise<number[]> { return (await this.all('SELECT version FROM schema_migrations ORDER BY version')).map(r => Number(r.version)); }
  /** Supabase에 대기 중인 마이그레이션을 각각 하나의 트랜잭션으로 적용한다. 이미 적용한 버전은 건너뛴다. */
  async applyMigrations(): Promise<number[]> {
    await this.ready;
    const applied: number[] = [];
    if (!this.sql) return applied;
    for (const m of MIGRATIONS) {
      const done = await this.sql.begin(async sql => {
        if ((await sql.unsafe('SELECT 1 FROM schema_migrations WHERE version=$1', [m.version])).length) return false;
        await sql.unsafe(readFileSync(join(PROJECT_ROOT, 'db', 'migrations', m.postgres), 'utf8'));
        return true;
      });
      if (done) applied.push(m.version);
    }
    this.cachedRevision = -1;
    return applied;
  }
  inTransaction() { return !!this.transactionState.getStore()?.active; }
  async revision() { return Number((await this.one("SELECT value FROM metadata WHERE key='revision'"))?.value || 0); }
  async runStatus(id: string) { return this.one(`SELECT status FROM runs WHERE id=?${this.sql && this.transactionState.getStore()?.active ? ' FOR SHARE' : ''}`, id); }
  snapshot(): Seed {
    if (!this.cached) throw new Error('조달 데이터를 먼저 로드하세요');
    return this.cached;
  }
  async data(): Promise<Seed> { return (await this.versionedData()).data; }
  async versionedData(): Promise<{ data: Seed; revision: number }> {
    const revision = await this.revision();
    if (this.cached && revision === this.cachedRevision) return { data: this.cached, revision };
    const read = async () => {
      const entries = async (table: string) => Object.fromEntries((await this.all(`SELECT id, data FROM ${table}`)).map(r => [r.id, JSON.parse(r.data)]));
      // 삭제한 체계(예: 마이그레이션 008 전의 laser) 행이 남아 있어도 읽지 않는다
      const known = (system: unknown) => (SYSTEM_KEYS as readonly unknown[]).includes(system);
      const systems = Object.fromEntries(Object.entries(await entries('systems')).filter(([id]) => known(id)));
      const meta = await this.one("SELECT value FROM metadata WHERE key='meta'");
      if (!meta) throw new Error('운영 데이터가 없습니다. 먼저 Supabase 이전 도구를 실행하세요');
      const data: Seed = { meta: JSON.parse(meta.value), countries: await entries('countries'), systems, sources: await entries('sources'), records: (await this.all('SELECT data FROM records ORDER BY id')).map(r => JSON.parse(r.data)).filter(r => known(r.system)) } as Seed;
      return { data, revision: await this.revision() };
    };
    const result = this.transactionState.getStore()?.active ? await read() : await this.transaction(read);
    this.cached = result.data;
    this.cachedRevision = result.revision;
    return result;
  }
  async createConversation(title = '새 대화') {
    const id = randomUUID(), date = now();
    await this.run('INSERT INTO conversations VALUES (?, ?, ?, ?)', id, title, date, date);
    for (const dir of ['attachments', 'sources', 'notes', 'analysis', 'reports', 'runs']) mkdirSync(join(this.workspace(id), dir), { recursive: true });
    return this.conversation(id);
  }
  workspace(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('잘못된 대화 ID');
    return join(this.storage, 'workspaces', id);
  }
  async conversationExists(id: string) { return !!await this.one('SELECT id FROM conversations WHERE id=?', id); }
  /** 대화 한 건: 원격 DB 왕복을 줄이려고 하위 조회를 동시에 보낸다. 실행 목록은 화면에 필요한 열만(결과 JSON 제외) */
  async conversation(id: string) {
    const [c, messages, files, runs, queued] = await Promise.all([
      this.one('SELECT * FROM conversations WHERE id=?', id),
      this.all('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid', id),
      this.all('SELECT * FROM artifacts WHERE conversation_id=? ORDER BY rowid', id),
      this.all('SELECT id,conversation_id,model,status,error,started_at,ended_at,owner_pid FROM runs WHERE conversation_id=? ORDER BY rowid DESC', id),
      this.queuedMessages(id),
    ]);
    if (!c) throw new Error('대화를 찾을 수 없습니다');
    return { ...c, workspace: this.workspace(id), messages: messages.map(m => ({ ...m, ...JSON.parse(m.payload) })), files, runs, queued };
  }
  async queuedMessages(id: string) {
    return (await this.all("SELECT r.id,r.model,e.data,e.created_at FROM runs r JOIN events e ON e.run_id=r.id AND e.name='run.queued' WHERE r.conversation_id=? AND r.status='queued' ORDER BY r.rowid", id)).map(row => ({ id: row.id, model: row.model, text: JSON.parse(row.data).messages[0].text, created_at: row.created_at }));
  }
  async message(id: string, role: string, text: string, payload: unknown = {}) {
    if (!await this.conversationExists(id)) throw new Error('대화를 찾을 수 없습니다');
    const date = now();
    await this.run('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)', randomUUID(), id, role, text, JSON.stringify(payload), date);
    await this.run('UPDATE conversations SET updated_at=? WHERE id=?', date, id);
    if (role === 'user') await this.run("UPDATE conversations SET title=? WHERE id=? AND title='새 대화'", text.slice(0, 60), id);
  }
  /** 제목 변경: 목록 순서를 흔들지 않도록 updated_at은 그대로 둔다 */
  async renameConversation(id: string, title: string) {
    const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!clean) throw new Error('제목을 입력하세요');
    if (!await this.conversationExists(id)) throw new Error('대화를 찾을 수 없습니다');
    await this.run('UPDATE conversations SET title=? WHERE id=?', clean, id);
    return { id, title: clean };
  }
  async deleteConversation(id: string) {
    if (!await this.conversationExists(id)) throw new Error('대화를 찾을 수 없습니다');
    await this.transaction(async () => {
      await this.run("UPDATE runs SET status='cancelled',error=?,ended_at=? WHERE conversation_id=? AND status='queued'", '대화 삭제로 대기 취소됨', now(), id);
      await this.run('UPDATE artifacts SET conversation_id=NULL WHERE conversation_id=?', id);
      await this.run('UPDATE reports SET conversation_id=NULL WHERE conversation_id=?', id);
      await this.run('UPDATE runs SET conversation_id=NULL WHERE conversation_id=?', id);
      await this.run('DELETE FROM conversations WHERE id=?', id);
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
  async artifact(id: string, name: string, content: string | Uint8Array, o: { runId?: string; mime?: string; kind?: string; url?: string; publishedAt?: string | null; status?: string; error?: string } = {}) {
    await this.conversation(id);
    const digest = hash(content);
    const old = ['attachment','extracted','original','search'].includes(o.kind || '') ? await this.one("SELECT * FROM artifacts WHERE conversation_id=? AND hash=? AND kind=? AND COALESCE(url,'')=?", id, digest, o.kind || 'note', o.url || '') : undefined;
    if (old) return old;
    const artifactId = randomUUID(), path = this.path(id, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    await this.syncFile(path);
    if (o.runId && o.kind !== 'tool-log' && (await this.one('SELECT status FROM runs WHERE id=?', o.runId))?.status !== 'running') throw new Error('종료되거나 중지된 조사 실행');
    await this.run('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', artifactId, id, o.runId || null, name, this.storedPath(path), o.mime || 'text/plain', digest, o.kind || 'note', o.status || 'ok', o.url || null, o.publishedAt || null, now(), o.error || null);
    return this.one('SELECT * FROM artifacts WHERE id=?', artifactId);
  }
  files(id: string): string[] {
    const root = this.workspace(id);
    const walk = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter(x => !x.isSymbolicLink() && !x.name.startsWith('.')).flatMap(x => x.isDirectory() ? walk(join(dir, x.name)) : [relative(root, join(dir, x.name)).replaceAll('\\', '/')]) : [];
    return walk(root);
  }
  private remotePath(value: any): any {
    if (typeof value !== 'string' || !isAbsolute(value)) return value;
    const rel = relative(this.storage, value).replaceAll('\\', '/');
    return rel.startsWith('workspaces/') && !rel.split('/').includes('..') ? rel : value;
  }
  // 경로 열에만 적용한다. 메시지·원문·로그 문자열은 경로처럼 보여도 변환하지 않는다.
  storedPath(path: string): string { return this.sql ? this.remotePath(path) : path; }
  private localPath(value: string): string {
    if (!/^workspaces\/[0-9a-f-]{36}\//i.test(value) || value.split('/').some(p => p === '..' || p.startsWith('.'))) throw new Error('잘못된 원격 파일 경로');
    const [, id, ...name] = value.split('/');
    return this.path(id, name.join('/'));
  }
  async ensureBucket() { await this.cloud?.ensureBucket(); }
  async syncFile(path: string) {
    if (!this.cloud) return;
    const remote = this.remotePath(path);
    if (remote === path || !String(remote).startsWith('workspaces/')) throw new Error('작업 폴더 밖의 파일');
    this.localPath(remote);
    const bytes = readFileSync(path), digest = hash(bytes);
    const previous = await this.one('SELECT hash FROM workspace_files WHERE path=?', remote);
    if (previous?.hash === digest) return;
    const artifact = await this.one('SELECT kind,hash FROM artifacts WHERE path=?', remote);
    if (artifact && !['note','analysis'].includes(artifact.kind) && artifact.hash !== digest) throw new Error('보존한 원문·첨부·완성 파일은 덮어쓸 수 없습니다');
    const key = `objects/${digest}`;
    await this.cloud.put(key, bytes);
    await this.run('INSERT INTO workspace_files(path,object_key,hash,bytes,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET object_key=excluded.object_key,hash=excluded.hash,bytes=excluded.bytes,updated_at=excluded.updated_at', remote, key, digest, bytes.length, now());
  }
  async ensureFile(path: string) {
    const remote = this.remotePath(path);
    if (this.cloud) this.localPath(remote);
    if (existsSync(path)) return path;
    if (!this.cloud) throw new Error('파일 없음');
    const entry = await this.one('SELECT * FROM workspace_files WHERE path=?', remote);
    if (!entry) throw new Error('보존한 원격 파일 없음');
    const bytes = await this.cloud.get(entry.object_key);
    if (hash(bytes) !== entry.hash) throw new Error('원격 파일 해시 불일치');
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
    return path;
  }
  async prepareWorkspace(id: string) {
    // 다른 PC에서 불러온 빈 대화에는 복원할 파일도 로컬 작업 폴더도 없을 수 있다.
    // 자식 CLI의 cwd를 먼저 준비한다. 폴더가 없으면 존재하는 node.exe도 ENOENT로 실패한다.
    const root = this.workspace(id);
    for (const dir of ['attachments', 'sources', 'notes', 'analysis', 'reports', 'runs']) mkdirSync(join(root, dir), { recursive: true });
    if (!this.cloud) return;
    const entries = await this.all('SELECT path FROM workspace_files WHERE path LIKE ?', `workspaces/${id}/%`);
    for (const entry of entries) await this.ensureFile(entry.path);
  }
  async syncWorkspace(id: string) { for (const file of this.files(id)) await this.syncFile(this.path(id, file, true)); }
  async event(runId: string, name: string, data: unknown) { await this.run('INSERT INTO events (run_id,name,data,created_at) VALUES (?,?,?,?)', runId, name, JSON.stringify(data), now()); }
  async backup(target: string) {
    if (this.sql) throw new Error('원격 DB 백업은 Supabase 이전 도구의 export 명령을 사용하세요');
    mkdirSync(dirname(target), { recursive: true }); await this.exclusive(() => backup(this.db, target));
  }
  async close() { await this.queue; if (this.sql) await this.sql.end({ timeout: 5 }); else this.db.close(); }
}
const globalStore = globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> };
export function repository(): Repository {
  const stores = globalStore.__radarRepositories ??= new Map();
  const key = `${DATABASE_KIND}:${DB_PATH}:schema5`;
  if (!stores.has(key)) stores.set(key, new Repository(DB_PATH, STORAGE_ROOT, DATABASE_KIND === 'sqlite', DATABASE_KIND === 'supabase' ? supabaseConfig() : undefined));
  return stores.get(key)!;
}
useDataProvider(() => repository().snapshot());
