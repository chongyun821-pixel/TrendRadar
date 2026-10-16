import { resolve, join } from 'node:path';
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { repository, STORAGE_ROOT, DB_PATH } from '../server/store';

const command = process.argv[2], target = process.argv[3] && resolve(process.argv[3]);
if (!target || !['backup','restore'].includes(command)) throw new Error('사용법: npm run db:backup -- <백업폴더> 또는 npm run db:restore -- <백업폴더> (복구는 서버·MCP 종료 후)');
if (command === 'backup') {
  if (existsSync(target)) throw new Error('새 백업 폴더 경로를 지정하세요');
  mkdirSync(target, { recursive: true });
  await repository().backup(join(target, 'radar.sqlite'));
  if (existsSync(join(STORAGE_ROOT, 'workspaces'))) cpSync(join(STORAGE_ROOT, 'workspaces'), join(target, 'workspaces'), { recursive: true });
  console.log(`SQLite·작업 폴더 백업 완료: ${target}`);
} else {
  const source = join(target, 'radar.sqlite');
  if (!existsSync(source)) throw new Error('백업 DB 없음');
  const check = new DatabaseSync(source, { readOnly: true });
  if (check.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('백업 DB 무결성 오류');
  if (existsSync(DB_PATH)) {
    const repo = repository();
    if (repo.one("SELECT id FROM runs WHERE status IN ('running','stopping')")) throw new Error('실행 중 조사 있음. 서버·MCP 종료 후 복구하세요');
    await repo.backup(`${DB_PATH}.before-restore-${Date.now()}`);
    repo.close();
  }
  mkdirSync(resolve(DB_PATH, '..'), { recursive: true });
  await backup(check, DB_PATH);
  check.close();
  if (existsSync(join(target, 'workspaces'))) cpSync(join(target, 'workspaces'), join(STORAGE_ROOT, 'workspaces'), { recursive: true });
  const restored = new DatabaseSync(DB_PATH);
  for (const row of restored.prepare('SELECT id,path,name FROM artifacts').all()) {
    const match = String(row.path).match(/[\\/]workspaces[\\/]([0-9a-f-]{36})[\\/]/i);
    if (match) restored.prepare('UPDATE artifacts SET path=? WHERE id=?').run(join(STORAGE_ROOT, 'workspaces', match[1], String(row.name)), row.id);
  }
  for (const row of restored.prepare('SELECT id,conversation_id,path FROM reports').all()) {
    const match = String(row.path).match(/[\\/]workspaces[\\/]([0-9a-f-]{36})[\\/]/i);
    if (match) restored.prepare('UPDATE reports SET path=? WHERE id=?').run(join(STORAGE_ROOT, 'workspaces', match[1], 'reports', String(row.path).split(/[\\/]/).at(-1)!), row.id);
  }
  restored.close();
  console.log('복구 완료. 기존 작업 폴더는 보존했습니다. 서버를 다시 시작하세요.');
}
