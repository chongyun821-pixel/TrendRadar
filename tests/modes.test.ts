import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository, MIGRATIONS } from '../server/store';
import { seed, resolveSystem } from '../shared/data';
import { SYSTEM_KEYS } from '../shared/types';
import { appContextSchema } from '../server/app-context';
import { recordSchema } from '../server/research';
import { TOOL_DEFS, ACTION_BLOCK_GUIDE } from '../server/agent';
import { computeForecast } from '../shared/forecast';

describe('모드 정리: IFV·레이저대공무기 (마이그레이션 004)', () => {
  it('장갑차 ID ifv는 유지하고 표기만 IFV로 바뀐다', () => {
    expect(seed.systems.ifv.ko).toBe('IFV');
    expect(resolveSystem('IFV')).toBe('ifv');
    expect(resolveSystem('장갑차')).toBe('ifv');
    expect(seed.records.filter(r => r.system === 'ifv').length).toBeGreaterThan(0);
  });
  it('레이저대공무기 체계와 별칭, 추정 단가 표시', () => {
    expect(SYSTEM_KEYS).toContain('laser');
    expect(seed.systems.laser).toMatchObject({ ko: '레이저대공무기', unitCostEst: true, costSrc: [] });
    for (const name of ['레이저대공무기', '레이저 대공무기 모드', '천광', 'DragonFire']) expect(resolveSystem(name), name).toBe('laser');
    expect(resolveSystem('대공미사일')).toBe('sam');
  });
  it('레이저 시드 기록은 출처가 있고 수량·시기를 지어내지 않는다', () => {
    const rec = seed.records.find(r => r.id === 'GBR-laser')!;
    expect(rec.batches).toEqual([]);
    expect(rec.awarded).toBeUndefined(); expect(rec.plan).toBeUndefined();
    for (const id of rec.src) expect(seed.sources[id]?.u).toMatch(/^https:\/\/www\.gov\.uk\//);
    expect(computeForecast(rec).status).toBe('none');
  });
  it('도구 설명·화면 맥락·조사 양식이 새 모드를 받는다', () => {
    const setMode = TOOL_DEFS.find(t => t.name === 'set_mode')!;
    expect(setMode.properties.system.description).toContain('IFV');
    expect(setMode.properties.system.description).toContain('레이저대공무기');
    expect(setMode.properties.system.description).not.toContain('장갑차');
    expect(ACTION_BLOCK_GUIDE).toContain('레이저대공무기');
    expect(appContextSchema.shape.mode.safeParse('laser').success).toBe(true);
    expect(recordSchema.safeParse({ id: 'X', country: 'GBR', system: 'laser', batches: [], src: [] }).success).toBe(true);
  });
  it('SQLite 마이그레이션은 한 번만 적용되고 다시 열어도 같은 결과', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-migrate-')), file = join(dir, 'db.sqlite');
    const first = new Repository(file, dir);
    expect(await first.schemaVersions()).toEqual(expect.arrayContaining([1, 2, 3, ...MIGRATIONS.map(m => m.version)]));
    await first.run("UPDATE weights SET weight=25 WHERE factor='intent'");
    await first.close();
    const second = new Repository(file, dir);
    try {
      expect((await second.one("SELECT weight FROM weights WHERE factor='intent'")).weight).toBe(25);
      expect((await second.all("SELECT * FROM records WHERE system='laser'")).length).toBe(1);
      expect((await second.all('SELECT * FROM system_links WHERE is_group=1')).length).toBe(7);
      expect(await second.revision()).toBe(1);
    } finally { await second.close(); }
  });
  it('빈 SQLite에는 조달 자료 없이 구조와 비중만 만든다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-empty-')), repo = new Repository(join(dir, 'db.sqlite'), dir, false);
    try {
      expect(await repo.all('SELECT * FROM systems')).toEqual([]);
      expect(await repo.all('SELECT * FROM records')).toEqual([]);
      expect((await repo.all('SELECT * FROM weights')).length).toBe(10);
    } finally { await repo.close(); }
  });
});
