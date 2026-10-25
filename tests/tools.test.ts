import { describe, expect, it } from 'vitest';
import { getInventory, getLifespan, searchMro } from '../shared/tools';

describe('shared lookup filters', () => {
  it('rejects unresolved explicit country and system filters', () => {
    expect(() => getInventory({ country: 'ZZZ' })).toThrow();
    expect(() => getInventory({ system: 'unknown-system' })).toThrow();
    expect(() => searchMro({ system: 'unknown-system' })).toThrow();
  });
  it('limits model lifespan matches to the requested system', () => {
    const all = getLifespan({ model: 'M113' }).models;
    const onlyIfv = getLifespan({ model: 'M113', system: 'ifv' }).models;
    expect(onlyIfv.length).toBeGreaterThan(0);
    expect(onlyIfv.length).toBeLessThanOrEqual(all.length);
    expect(onlyIfv.every(row => row.model.toLowerCase().includes('m113'))).toBe(true);
    expect(getLifespan({ system: 'ifv' }).systems).toHaveLength(1);
  });
});
