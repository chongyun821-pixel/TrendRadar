import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Repository, DB_PATH, STORAGE_ROOT, supabaseConfig } from '../server/store';
import { importSnapshot, localSnapshot, verifySnapshot, snapshotHash, exportSnapshot, type Snapshot } from '../server/migration';
import { databaseClient } from '../server/supabase';

const command = process.argv[2] || 'check';
const config = supabaseConfig();
try {
  if (command === 'check') {
    const sql = databaseClient(config);
    try { await sql`SELECT 1 AS ok`; console.log('PostgreSQL 연결 성공'); }
    finally { await sql.end({ timeout: 5 }); }
    const response = await fetch(`${config.url}/storage/v1/bucket`, { headers: { apikey: config.secretKey, Authorization: `Bearer ${config.secretKey}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Storage 인증 실패 (HTTP ${response.status})`);
    console.log('Storage 인증 성공. 비밀값은 출력하지 않았습니다.');
  } else if (command === 'schema') {
    // 대기 중인 구조·자료 마이그레이션(db/migrations/*.postgres.sql)을 버전별 트랜잭션으로 적용한다.
    const target = new Repository(DB_PATH, STORAGE_ROOT, false, config);
    try { const applied = await target.applyMigrations(); console.log(JSON.stringify({ applied, versions: await target.schemaVersions() })); }
    finally { await target.close(); }
  } else if (['migrate','verify','export','restore'].includes(command)) {
    let folder = process.argv[3] && resolve(process.argv[3]);
    if (command === 'migrate' && !folder) {
      folder = join(STORAGE_ROOT, 'backups', `before-supabase-${Date.now()}-${randomUUID().slice(0,8)}`);
      const local = new Repository(DB_PATH, STORAGE_ROOT);
      try {
        localSnapshot(DB_PATH, STORAGE_ROOT); // 실행 중인 조사가 있으면 백업 전에 중단한다.
        mkdirSync(folder, { recursive: true });
        await local.backup(join(folder, 'radar.sqlite'));
        if (existsSync(join(STORAGE_ROOT, 'workspaces'))) cpSync(join(STORAGE_ROOT, 'workspaces'), join(folder, 'workspaces'), { recursive: true });
      } finally { await local.close(); }
      console.log(`원본 백업: ${folder}`);
    }
    if (!folder) throw new Error('백업 폴더 경로가 필요합니다');
    const target = new Repository(DB_PATH, command === 'export' ? STORAGE_ROOT : folder, false, config);
    try {
      if (command === 'export') {
        const snapshot = await exportSnapshot(target, folder);
        console.log(JSON.stringify({ backup: folder, sourceHash: snapshotHash(snapshot) }));
      } else {
        const snapshot: Snapshot = existsSync(join(folder, 'snapshot.json')) ? JSON.parse(readFileSync(join(folder, 'snapshot.json'), 'utf8')) : localSnapshot(join(folder, 'radar.sqlite'), folder);
        if (command === 'migrate' || command === 'restore') await importSnapshot(target, snapshot);
        const result = await verifySnapshot(target, snapshot, config);
        if (command === 'migrate' && snapshotHash(localSnapshot(DB_PATH, STORAGE_ROOT)) !== snapshotHash(snapshot)) throw new Error('이전 중 로컬 원본이 변경됐습니다. 운영 전환 전에 추가 변경을 반영해야 합니다');
        writeFileSync(join(folder, 'supabase-receipt.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), ...result }, null, 2));
        console.log(JSON.stringify({ verified: true, ...result }));
      }
    } finally { await target.close(); }
  } else throw new Error('사용법: npm run supabase -- check | schema | migrate [백업폴더] | verify <백업폴더> | export <새폴더> | restore <백업폴더>');
} catch (e: any) {
  // 드라이버 오류의 연결 옵션·매개변수에는 자격 증명이 들어갈 수 있다.
  const code = (e as any)?.code;
  const known = e instanceof Error && !code ? e.message : `Supabase 작업 실패 (${code || 'connection'})`;
  const safe = [config.databaseUrl, config.secretKey].filter(Boolean).reduce((s,key) => s.replaceAll(key, '[redacted]'), known);
  console.error(safe); process.exitCode = 1;
}
