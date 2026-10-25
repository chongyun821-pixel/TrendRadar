import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Repository } from '../server/store';
import { lookupWeapon, normalizeWeaponRow } from '../server/weapons';
import { runTool, TOOL_DEFS, newOut } from '../server/agent';
import { executions } from '../server/execution';
import { buildWeaponMatcher } from '../src/weapon-tooltip';

describe('weapon dictionary', () => {
  it('normalizes JSON text and already parsed SQLite/Postgres fields', () => {
    const fromSqlite = normalizeWeaponRow({ id: 'k9', name: 'K9 Thunder', name_ko: 'K9 자주포', aliases: '["K9 Thunder"]', system: 'sph', operators: '["KOR"]', specs: '{"caliber":"155mm"}', variants: '[]', sources: '[]', est: '[]', description: '설명', intro_year: null });
    const fromPostgres = normalizeWeaponRow({ ...fromSqlite, aliases: ['K9 Thunder'], operators: ['KOR'], specs: { caliber: '155mm' }, variants: [], sources: [], est: [] , name_ko: 'K9 자주포', intro_year: null });
    expect(fromSqlite.aliases).toEqual(['K9 Thunder']);
    expect(fromPostgres.operatorsKo).toContain('대한민국');
    expect(fromSqlite.specs).toEqual({ caliber: '155mm' });
  });

  it('looks up the migration alias without case sensitivity and registers the tool', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'weapons-test-'));
    const repo = new Repository(join(folder, 'db.sqlite'), folder);
    try {
      const result = await lookupWeapon('k9 thunder', undefined, repo);
      expect(result.match?.id).toBe('k9-thunder');
      expect(TOOL_DEFS.some(tool => tool.name === 'lookup_weapon')).toBe(true);
      const conversation = await repo.createConversation(), runId = randomUUID();
      await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, conversation.id, 'test', 'running', new Date().toISOString());
      const toolResult = await executions.run({ conversationId: conversation.id, runId, signal: new AbortController().signal, repo, env: {} }, () => runTool('lookup_weapon', { query: 'K9 Thunder' }, newOut()));
      expect((toolResult as any).match.id).toBe('k9-thunder');
    } finally { await repo.close(); }
  });

  it('prefers the longest term when weapon terms overlap', () => {
    const entries: any[] = [
      { id: 'short', name: 'K9', nameKo: 'K9', aliases: ['K9'], systemKo: '', typeKo: '', maker: null, originKo: '', operatorsKo: [], introYear: null, description: '' },
      { id: 'long', name: 'K9 Thunder', nameKo: 'K9 Thunder', aliases: ['K9 Thunder'], systemKo: '', typeKo: '', maker: null, originKo: '', operatorsKo: [], introYear: null, description: '' },
    ];
    expect(buildWeaponMatcher(entries)[0].entry.id).toBe('long');
  });
});
