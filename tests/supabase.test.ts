import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Repository, supabaseConfig, now } from '../server/store';
import { databaseClient, postgresQuery } from '../server/supabase';
import { importSnapshot, localSnapshot, verifySnapshot, exportSnapshot } from '../server/migration';
import { executions } from '../server/execution';
import { researchTool, submitResearch } from '../server/research';
import { saveAppContext, readAppContext, pendingCommands } from '../server/app-context';
import { runTool, newOut } from '../server/agent';
import type { AppContext } from '../shared/app-context';

describe('SQL 호환·비동기 트랜잭션', () => {
  it('값의 물음표와 SQL 문자열 리터럴을 구분하고 조회 순서·충돌 구문을 보존', () => {
    expect(postgresQuery("SELECT '?' AS literal FROM messages WHERE text=? ORDER BY rowid")).toBe("SELECT '?' AS literal FROM messages WHERE text=$1 ORDER BY row_order");
    expect(postgresQuery('INSERT OR IGNORE INTO sources VALUES (?,?)')).toBe('INSERT INTO sources VALUES ($1,$2) ON CONFLICT DO NOTHING');
  });
  it('SQLite에서도 비동기 트랜잭션 밖의 쓰기가 롤백에 섞이지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(),'radar-tx-')), repo = new Repository(join(dir,'db.sqlite'),dir);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
    const tx = repo.transaction(async () => { await repo.run('INSERT INTO metadata VALUES(?,?)','rolled-back','x'); entered(); await gate; throw new Error('rollback'); });
    await started;
    const outside = repo.run('INSERT INTO metadata VALUES(?,?)','preserved','x');
    const rejection = expect(tx).rejects.toThrow('rollback'); release();
    await rejection; await outside;
    expect(await repo.one("SELECT * FROM metadata WHERE key='rolled-back'")).toBeUndefined();
    expect(await repo.one("SELECT * FROM metadata WHERE key='preserved'")).toBeDefined();
    await repo.close();
  });
  it('자료와 버전을 함께 조회하고 이후 갱신에도 이전 스냅샷을 유지한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-version-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
    try {
      const before = await repo.versionedData();
      await repo.transaction(async () => {
        await repo.run("UPDATE metadata SET value=? WHERE key='meta'", JSON.stringify({ ...before.data.meta, collected: '2026-10-17T00:00:00Z' }));
        await repo.run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
      });
      const after = await repo.versionedData();
      expect(after.revision).toBe(before.revision + 1);
      expect(after.data.meta.collected).toBe('2026-10-17T00:00:00Z');
      expect(before.data.meta.collected).not.toBe(after.data.meta.collected);
    } finally { await repo.close(); }
  });
});

describe.runIf(process.env.RADAR_TEST_SUPABASE === '1')('실제 Supabase 격리 검증 (모델·조사 자료는 가상)', () => {
  const suffix = randomUUID().replaceAll('-','');
  const config = { ...supabaseConfig(), schema: `trendradar_test_${suffix}`, bucket: `trendradar-test-${suffix}` };
  const dir = mkdtempSync(join(tmpdir(),'radar-supabase-'));
  let repo: Repository;
  let initialized = false;
  beforeAll(async () => {
    const original = new Repository(join(dir,'source.sqlite'),dir);
    await original.close();
    repo = new Repository('',dir,false,config);
    await importSnapshot(repo,localSnapshot(join(dir,'source.sqlite'),dir));
    initialized = true;
  }, 60000);
  afterAll(async () => {
    await repo?.close();
    const sql = databaseClient(config);
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${config.schema}" CASCADE`);
      await sql.unsafe(`DROP SCHEMA IF EXISTS "trendradar_restore_${suffix}" CASCADE`);
    }
    finally { await sql.end({ timeout: 5 }); }
    if (initialized) {
      const client = createClient(config.url,config.secretKey);
      await client.storage.emptyBucket(config.bucket);
      await client.storage.deleteBucket(config.bucket);
    }
  }, 60000);
  it('전체 SQL 객체·순서·예측을 이전하고 중복 이전이 데이터를 덮어쓰지 않는다', async () => {
    const snapshot = localSnapshot(join(dir,'source.sqlite'),dir);
    await importSnapshot(repo,snapshot);
    expect((await verifySnapshot(repo,snapshot,config)).records).toBe(59);
    const altered = structuredClone(snapshot); altered.tables.find(t => t.name==='metadata')!.rows[0].value='changed';
    await expect(importSnapshot(repo,altered)).rejects.toThrow(/덮어쓰지/);
  }, 60000);
  it('원문·한글 파일을 원격 보존하고 새 로컬 캐시에서 해시 그대로 복원, 조사 반영·충돌·중지·삭제 후 근거 보존', async () => {
    const c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)',runId,c.id,'test','running',now());
    const ctx = { repo, conversationId: c.id, runId, signal: controller.signal, env: {} };
    const screen: AppContext = { screenId: randomUUID(), version: 1, conversationId: c.id, model: 'gemma', activeView: 'map', mode: 'sph', flat: false, focus: 'POL', filters: { system: 'sph' }, report: null, dataVersion: await repo.revision() };
    await saveAppContext(repo, screen);
    await executions.run({ ...ctx, appContext: screen }, async () => {
      expect(await runTool('get_app_context', {}, newOut())).toMatchObject({ request: { focus: 'POL' }, current: { state: { focus: 'POL' } } });
      expect(await runTool('set_map_state', { payload: '{"country":"FIN"}' }, newOut())).toMatchObject({ status: 'pending' });
    });
    let path = '';
    await executions.run(ctx,async () => {
      const quote = '격리 검증용 가상 계획: 2031~2033년 10~12문';
      const source: any = await researchTool('save_source',{url:'https://example.org/supabase-test',content:quote,kind:'original',publishedAt:'2026-10-16'});
      path=repo.path(c.id,source.filePath,true);
      await repo.message(c.id, 'user', path);
      expect((await repo.conversation(c.id)).messages[0].text).toBe(path);
      const record=structuredClone((await repo.data()).records.find(r=>r.country==='POL'&&r.system==='sph')!);
      record.plan={start:2031,end:2033,qty:[10,12],text:quote,src:['cloud-test']};record.src.push('cloud-test');
      const payload={record,expectedVersion:1,asOf:'2026-10-16',reason:'격리 검증',sources:{'cloud-test':{...source,status:undefined,t:'가상 근거',u:'https://example.org/supabase-test',y:2026}},evidence:[{path:'plan',sourceId:'cloud-test',quote}]};
      expect((await submitResearch(payload)).forecast!.qty).toEqual([10,12]);
      await expect(submitResearch(payload)).rejects.toThrow(/버전 충돌/);
      writeFileSync(path,'수정된 원문');
      await expect(repo.syncFile(path)).rejects.toThrow(/덮어쓸/);
      writeFileSync(path,quote);
      const notePath = 'analysis/한글 자료.txt';
      await researchTool('workspace_write', { path: notePath, content: '첫 메모' });
      await researchTool('workspace_write', { path: notePath, content: '한글 파일 보존' });
      const file=repo.path(c.id,notePath);await repo.syncWorkspace(c.id);
      rmSync(file);await repo.ensureFile(file);expect(readFileSync(file,'utf8')).toBe('한글 파일 보존');
      const coldDir=mkdtempSync(join(tmpdir(),'radar-cold-')), cold=new Repository('',coldDir,false,config);
      try {
        await cold.prepareWorkspace(c.id);
        expect(readFileSync(cold.path(c.id,source.filePath,true),'utf8')).toBe(quote);
        expect((await cold.conversation(c.id)).messages[0].text).toBe(path);
        expect(await readAppContext(cold, screen.screenId)).toMatchObject({ state: { focus: 'POL' } });
        expect(await pendingCommands(cold, screen.screenId)).toHaveLength(1);
      }
      finally { await cold.close(); }
      await repo.run("UPDATE runs SET status='stopping' WHERE id=?",runId);
      await expect(submitResearch({...payload,expectedVersion:2})).rejects.toThrow(/중지/);
    });
    await repo.run("UPDATE runs SET status='cancelled' WHERE id=?",runId);
    expect(await pendingCommands(repo, screen.screenId)).toHaveLength(0);
    await repo.deleteConversation(c.id);
    expect(await repo.all('SELECT * FROM changes')).toHaveLength(1);
    expect(readFileSync(path,'utf8')).toContain('격리 검증');
  }, 60000);
  it('원격 전체 백업을 빈 스키마로 복구하고 삭제된 대화의 원문·이력도 검증한다', async () => {
    const folder=join(dir,'cloud-backup');
    const snapshot=await exportSnapshot(repo,folder);
    const restoreConfig={...config,schema:`trendradar_restore_${suffix}`};
    const restored=new Repository('',folder,false,restoreConfig);
    try {
      await importSnapshot(restored,snapshot);
      expect((await verifySnapshot(restored,snapshot,restoreConfig)).files).toBe(2);
      expect(await restored.all('SELECT * FROM conversations')).toHaveLength(0);
      expect(await restored.all('SELECT * FROM changes')).toHaveLength(1);
    } finally {
      await restored.close();
      const sql=databaseClient(restoreConfig);
      try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${restoreConfig.schema}" CASCADE`); }
      finally { await sql.end({timeout:5}); }
    }
  }, 180000);
});
