import { describe, expect, it } from 'vitest';
import { DATA_TABLES, portableTableRow, snapshotHash, type Snapshot } from '../server/migration';

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
