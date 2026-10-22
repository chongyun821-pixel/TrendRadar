import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Repository, now } from '../server/store';
import { executions } from '../server/execution';
import { chatCodex } from '../server/cli';

describe('새 PC의 CLI 대화 작업 폴더', () => {
  it('DB에만 있는 빈 대화를 준비하면 Node 자식 프로세스를 실행할 수 있다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-cli-workspace-'));
    const repo = new Repository(join(dir, 'db.sqlite'), dir, false);
    const id = randomUUID(), date = now();
    try {
      // 다른 PC에서 만들어 DB로 불러온 대화는 이 PC에 로컬 폴더가 없다.
      await repo.run('INSERT INTO conversations VALUES(?,?,?,?)', id, '기존 원격 대화', date, date);
      const cwd = repo.workspace(id);
      expect(existsSync(cwd)).toBe(false);
      await repo.prepareWorkspace(id);
      const child = spawnSync(process.execPath, ['--version'], { cwd, encoding: 'utf8', windowsHide: true });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toMatch(/^v\d+\./);
    } finally { await repo.close(); }
  });
  it('Codex 어댑터를 직접 호출해도 작업 폴더를 준비한 후 공백·한글 경로에서 CLI를 실행한다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-cli 한글 경로-'));
    const repo = new Repository(join(dir, 'db.sqlite'), dir, false);
    const id = randomUUID(), runId = randomUUID(), date = now();
    const bin = join(dir, 'fixture-codex.mjs');
    writeFileSync(bin, `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: process.cwd() } }) + '\\n'));`);
    try {
      await repo.run('INSERT INTO conversations VALUES(?,?,?,?)', id, 'CLI 어댑터 검증', date, date);
      await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, id, 'test', 'running', date);
      expect(existsSync(repo.workspace(id))).toBe(false);
      const response = await executions.run({ repo, runId, conversationId: id, env: {}, signal: new AbortController().signal }, () => chatCodex({ messages: [{ role: 'user', text: '작업 경로 확인' }] }, { CODEX_BIN: bin, CLI_RUNTIME_DIR: join(dir, 'runtime') }));
      expect(response.error).toBeUndefined();
      expect(response.reply).toBe(repo.workspace(id));
    } finally { await repo.close(); }
  });
});
