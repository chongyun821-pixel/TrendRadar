import { describe, expect, it } from 'vitest';
import { DATA_TABLES, portableTableRow, snapshotHash, type Snapshot } from '../server/migration';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Repository } from '../server/store';

describe('SQLite dictionary migration', () => {
  it.each([true, false])('applies dictionary updates once with image_url initially present=%s', async hasImageColumn => {
    const folder = mkdtempSync(join(tmpdir(), 'radar-dictionary-migration-')), file = join(folder, 'test.sqlite');
    const initial = new Repository(file, folder);
    const revision = await initial.revision();
    await initial.run("INSERT OR REPLACE INTO weapon_dictionary(id,name,name_ko,system,description,updated_at) VALUES('agosta-90b','Test submarine','검증용 잠수함','ssk','stale',?)", new Date().toISOString());
    await initial.close();
    const db = new DatabaseSync(file);
    try {
      db.exec("DELETE FROM schema_migrations WHERE version=14; UPDATE weapon_dictionary SET description='stale' WHERE id='agosta-90b';");
      if (hasImageColumn) db.exec("UPDATE weapon_dictionary SET image_url=NULL WHERE id='agosta-90b'");
      else db.exec('ALTER TABLE weapon_dictionary DROP COLUMN image_url');
    } finally { db.close(); }
    const migrated = new Repository(file, folder);
    try {
      const row = await migrated.one("SELECT description, image_url FROM weapon_dictionary WHERE id='agosta-90b'");
      expect(row.description).not.toBe('stale');
      expect(row.image_url).toMatch(/^https:\/\//);
      expect(await migrated.schemaVersions()).toContain(14);
      expect(await migrated.revision()).toBe(revision + 1);
      await migrated.run("UPDATE weapon_dictionary SET description='reviewed' WHERE id='agosta-90b'");
    } finally { await migrated.close(); }
    const reopened = new Repository(file, folder);
    try {
      expect((await reopened.one("SELECT description FROM weapon_dictionary WHERE id='agosta-90b'")).description).toBe('reviewed');
    } finally { await reopened.close(); }
  });
});

describe('snapshot table registry', () => {
  it('includes weapon_dictionary for export, restore, and verification', () => {
    expect(DATA_TABLES).toContain('weapon_dictionary');
  });
  it('preserves array and JSONB dictionary values through snapshot JSON round trips', () => {
    const snapshot: Snapshot = { format: 'trendradar-v1', files: [], tables: [{ name: 'weapon_dictionary', columns: ['id', 'aliases', 'operators', 'variants', 'est', 'specs', 'sources'], rows: [portableTableRow('weapon_dictionary', { id: 'test', aliases: '[\"Alias A\",\"Alias B\"]', operators: '[\"POL\"]', variants: '[\"Variant A\"]', est: '[\"specs\"]', specs: '{\"rangeKm\":42,\"notes\":[\"a\",\"b\"]}', sources: '[{\"id\":\"src-1\",\"y\":2026}]' })], order: [] }] };
    const restored = JSON.parse(JSON.stringify(snapshot)) as Snapshot;
    expect(restored.tables[0].rows[0]).toEqual(snapshot.tables[0].rows[0]);
    expect(restored.tables[0].rows[0]).toMatchObject({ aliases: ['Alias A', 'Alias B'], operators: ['POL'], variants: ['Variant A'], est: ['specs'], specs: { rangeKm: 42, notes: ['a', 'b'] }, sources: [{ id: 'src-1', y: 2026 }] });
    expect(snapshotHash(restored)).toBe(snapshotHash(snapshot));
  });
});
