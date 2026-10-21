import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { Repository, hash } from './store';
import { SupabaseFiles, type SupabaseConfig } from './supabase';
import { computeForecast } from '../shared/forecast';

export const DATA_TABLES = ['schema_migrations','metadata','countries','systems','sources','records','conversations','messages','context_summaries','runs','events','artifacts','research','changes','forecasts','reports','app_contexts','app_commands','system_links','export_tiers','export_controls','neighbors','inventory','budgets','signals','consumption','supplier_capacity','domestic_capability','weights','pair_events'] as const;
const ORDERED = new Set(['messages','runs','artifacts','research']);
export interface SnapshotTable { name: string; columns: string[]; rows: Record<string, any>[]; order: number[] }
export interface SnapshotFile { path: string; hash: string; bytes: number }
export interface Snapshot { format: 'trendradar-v1'; tables: SnapshotTable[]; files: SnapshotFile[] }

export function portablePath(path: string) {
  const value = path.replaceAll('\\', '/');
  const match = value.match(/(?:^|\/)workspaces\/([0-9a-f-]{36})\/(.+)$/i);
  return match ? `workspaces/${match[1]}/${match[2]}` : path;
}
function portable(row: Record<string, any>) {
  const result = { ...row };
  if (typeof result.path === 'string') result.path = portablePath(result.path);
  return result;
}
function canonical(rows: Record<string, any>[]) {
  return rows.map(portable).map(row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b]) => a.localeCompare(b))))).sort();
}
export function snapshotHash(snapshot: Snapshot) {
  return hash(JSON.stringify({ tables: snapshot.tables.map(t => ({ name: t.name, rows: canonical(t.rows), order: ORDERED.has(t.name) ? t.rows.map(r => r.id) : [] })), files: snapshot.files }));
}
export function localSnapshot(database: string, storage: string): Snapshot {
  const db = new DatabaseSync(database, { readOnly: true });
  const tables: SnapshotTable[] = [];
  try {
    db.exec('BEGIN');
    if (db.prepare("SELECT id FROM runs WHERE status IN ('queued','running','stopping') LIMIT 1").get()) throw new Error('조사가 대기 또는 진행 중입니다. 종료 후 이전하세요');
    for (const name of DATA_TABLES) {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all().map(r => String(r.name));
      if (!columns.length) continue;
      const original = db.prepare(`SELECT rowid AS __row_order,* FROM "${name}" ORDER BY rowid`).all();
      tables.push({ name, columns, order: original.map(r => Number(r.__row_order)), rows: original.map(row => { const { __row_order, ...rest } = row; return portable(rest); }) });
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const files: SnapshotFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('작업 폴더에 심볼릭 링크가 있습니다. 이전 대상 확인 필요');
      if (entry.isDirectory()) walk(path);
      else files.push({ path: relative(storage, path).replaceAll('\\', '/'), hash: hash(readFileSync(path)), bytes: statSync(path).size });
    }
  };
  if (existsSync(join(storage, 'workspaces'))) walk(join(storage, 'workspaces'));
  files.sort((a,b) => a.path.localeCompare(b.path));
  return { format: 'trendradar-v1', tables, files };
}

export async function importSnapshot(target: Repository, snapshot: Snapshot) {
  if (target.kind !== 'supabase') throw new Error('Supabase 저장소로만 이전할 수 있습니다');
  if (snapshot.format !== 'trendradar-v1') throw new Error('지원하지 않는 백업 형식');
  for (const file of snapshot.files) {
    const parts = file.path.split('/');
    if (!/^workspaces\/[0-9a-f-]{36}\//i.test(file.path) || parts.some(p => !p || p.startsWith('.')) || file.path.includes('\\')) throw new Error('잘못된 백업 파일 경로');
    target.path(parts[1], parts.slice(2).join('/'), true);
  }
  const signature = snapshotHash(snapshot);
  await target.ready;
  const receipt = await target.one("SELECT value FROM metadata WHERE key='_migration_source'");
  if (receipt && receipt.value !== signature) throw new Error('대상 DB에 다른 자료가 있습니다. 기존 데이터를 덮어쓰지 않습니다');
  if (!receipt) await target.transaction(async () => {
    for (const name of DATA_TABLES) if ((await target.one(`SELECT COUNT(*) AS n FROM "${name}"`)).n > 0) throw new Error('빈 대상 DB에만 최초 이전할 수 있습니다');
    for (const table of snapshot.tables) {
      if (!DATA_TABLES.includes(table.name as any)) throw new Error('지원하지 않는 백업 테이블');
      const columns = [...table.columns];
      if (ORDERED.has(table.name)) columns.push('row_order');
      if (columns.some(c => !/^[a-z_]+$/.test(c))) throw new Error('잘못된 백업 열 이름');
      for (let start = 0; start < table.rows.length; start += 200) {
        const batch = table.rows.slice(start, start + 200);
        const values = batch.flatMap((row, offset) => [...table.columns.map(c => row[c]), ...(ORDERED.has(table.name) ? [table.order[start + offset]] : [])]);
        const placeholders = batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',');
        await target.run(`INSERT INTO "${table.name}"(${columns.map(c => `"${c}"`).join(',')}) VALUES${placeholders}`, ...values);
      }
    }
    for (const name of ['events','changes','forecasts',...ORDERED]) {
      const column = ORDERED.has(name) ? 'row_order' : 'id';
      await target.all(`SELECT setval(pg_get_serial_sequence('${name}','${column}'),COALESCE(MAX("${column}"),0)+1,false) FROM "${name}"`);
    }
    await target.run('INSERT INTO metadata(key,value) VALUES(?,?)', '_migration_source', signature);
  });
  // DB가 먼저 복사됐더라도 파일 전송 실패 시 같은 스냅샷으로 이어 실행할 수 있다.
  await verifyTables(target, snapshot);
  await target.ensureBucket();
  for (const file of snapshot.files) {
    const local = join(target.storage, file.path);
    if (hash(readFileSync(local)) !== file.hash) throw new Error('백업 파일이 변경됐습니다');
    await target.syncFile(local);
  }
}

async function verifyTables(target: Repository, snapshot: Snapshot) {
  for (const table of snapshot.tables) {
    const rows = (await target.all(`SELECT ${table.columns.map(c => `"${c}"`).join(',')} FROM "${table.name}"`)).filter(r => table.name !== 'metadata' || !r.key.startsWith('_migration_'));
    if (JSON.stringify(canonical(rows)) !== JSON.stringify(canonical(table.rows))) throw new Error(`이전 데이터 불일치: ${table.name}`);
    if (ORDERED.has(table.name)) {
      const ordered = await target.all(`SELECT id FROM "${table.name}" ORDER BY rowid`);
      if (JSON.stringify(ordered.map(r => r.id)) !== JSON.stringify(table.rows.map(r => r.id))) throw new Error(`이전 순서 불일치: ${table.name}`);
    }
  }
}
export async function verifySnapshot(target: Repository, snapshot: Snapshot, config: SupabaseConfig) {
  await verifyTables(target, snapshot);
  const files = new SupabaseFiles(config);
  const manifest = await target.all('SELECT * FROM workspace_files');
  if (manifest.length !== snapshot.files.length) throw new Error('이전 파일 건수 불일치');
  for (const file of snapshot.files) {
    const row = manifest.find(r => portablePath(r.path) === file.path);
    if (!row || row.hash !== file.hash || Number(row.bytes) !== file.bytes) throw new Error('이전 파일 목록 불일치');
    if (hash(await files.get(row.object_key)) !== file.hash) throw new Error('원격 파일 해시 불일치');
  }
  const data = await target.data();
  const entries = (name: string) => Object.fromEntries(snapshot.tables.find(t => t.name === name)!.rows.map(r => [r.id, JSON.parse(r.data)]));
  const original = { ...data, countries: entries('countries'), systems: entries('systems'), sources: entries('sources'), records: snapshot.tables.find(t => t.name === 'records')!.rows.map(r => JSON.parse(r.data)) };
  for (const record of data.records) {
    const before = original.records.find((r: any) => r.id === record.id);
    if (JSON.stringify(computeForecast(before, original)) !== JSON.stringify(computeForecast(record, data))) throw new Error('이전 후 예측 계산 불일치');
  }
  return { tables: snapshot.tables.length, rows: snapshot.tables.reduce((n,t) => n+t.rows.length,0), records: data.records.length, files: snapshot.files.length, fileBytes: snapshot.files.reduce((n,f) => n+f.bytes,0), sourceHash: snapshotHash(snapshot) };
}

export async function exportSnapshot(repo: Repository, folder: string) {
  if (existsSync(folder)) throw new Error('새 백업 폴더를 지정하세요');
  const snapshot = await repo.transaction(async () => {
    if (await repo.one("SELECT id FROM runs WHERE status IN ('queued','running','stopping') LIMIT 1")) throw new Error('대기 중인 요청과 조사 종료 후 백업하세요');
    const tables: SnapshotTable[] = [];
    for (const name of DATA_TABLES) {
      const columns = (await repo.all('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=? ORDER BY ordinal_position', name)).map(r => r.column_name).filter(c => c !== 'row_order');
      const rows = (await repo.all(`SELECT * FROM "${name}"${ORDERED.has(name) ? ' ORDER BY rowid' : ''}`)).filter(r => name !== 'metadata' || !r.key.startsWith('_migration_')).map(portable);
      tables.push({ name, columns, rows, order: rows.map((_,i) => i+1) });
    }
    const files = (await repo.all('SELECT path,hash,bytes FROM workspace_files ORDER BY path')).map(f => ({ path: portablePath(f.path), hash: f.hash, bytes: Number(f.bytes) })).sort((a,b) => a.path.localeCompare(b.path));
    return { format: 'trendradar-v1' as const, tables, files };
  });
  mkdirSync(folder, { recursive: true });
  for (const file of snapshot.files) {
    const local = join(repo.storage, file.path);
    await repo.ensureFile(local);
    const bytes = readFileSync(local);
    if (hash(bytes) !== file.hash) throw new Error('백업 파일 해시 불일치');
    const output = join(folder, file.path);
    mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, bytes);
  }
  writeFileSync(join(folder, 'snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(folder, 'receipt.json'), JSON.stringify({ sourceHash: snapshotHash(snapshot), createdAt: new Date().toISOString() }, null, 2));
  return snapshot;
}
