import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository, MIGRATIONS } from '../server/store';
import { seed, resolveSystem } from '../shared/data';
import { SYSTEM_KEYS } from '../shared/types';
import { appContextSchema } from '../server/app-context';
import { recordSchema } from '../server/research';
import { TOOL_DEFS, SCREEN_RULE } from '../server/agent';
import { selectRows } from '../server/collection';

const LASER = { ko: '레이저대공무기', unit: '기', designLife: 20, unitCost: [300, 1500], unitCostEst: true, costSrc: [] };
const LASER_RECORD = { id: 'GBR-laser', country: 'GBR', system: 'laser', batches: [], src: ['gbr_dragonfire'] };
/** 008 이전 운영 DB처럼 laser 행을 넣는다 */
async function insertLaserRows(repo: Repository) {
  const at = '2026-01-01T00:00:00.000Z';
  await repo.run("INSERT INTO systems(id,data) VALUES ('laser', ?)", JSON.stringify(LASER));
  await repo.run("INSERT INTO sources(id,data) VALUES ('gbr_dragonfire', ?), ('kor_cheongwang', ?)", JSON.stringify({ t: 'DragonFire', u: 'https://www.gov.uk/' }), JSON.stringify({ t: '천광', u: 'https://www.korea.kr/' }));
  await repo.run("INSERT INTO records(id,country,system,data,version,updated_at) VALUES ('GBR-laser','GBR','laser',?,1,?)", JSON.stringify(LASER_RECORD), at);
  await repo.run("INSERT INTO system_links(system,model,maker,is_group,relation,source_id,confidence,collected_at) VALUES ('laser','천광','한화에어로스페이스',1,'group','kor_cheongwang',1,?)", at);
  await repo.run("INSERT INTO domestic_capability(country,system,status,program,source_id,confidence,collected_at) VALUES ('GBR','laser','development','DragonFire','gbr_dragonfire',1,?)", at);
  await repo.run("INSERT INTO export_tiers(country,system,tier,tier_reasons,tier_checked_at,source_id,confidence,collected_at) VALUES ('GBR','laser',2,'{}',?,'tiers',1,?)", at, at);
}

describe('모드 정리: IFV 표기와 레이저대공무기 삭제 (마이그레이션 004, 008)', () => {
  it('장갑차 ID ifv는 유지하고 표기만 IFV로 바뀐다', () => {
    expect(seed.systems.ifv.ko).toBe('IFV');
    expect(resolveSystem('IFV')).toBe('ifv');
    expect(resolveSystem('장갑차')).toBe('ifv');
    expect(seed.records.filter(r => r.system === 'ifv').length).toBeGreaterThan(0);
  });
  it('레이저대공무기 체계, 기록, 별칭이 없고, 그 이름이 대공미사일로 풀리지 않는다', () => {
    expect(SYSTEM_KEYS).not.toContain('laser');
    expect(Object.keys(seed.systems)).not.toContain('laser');
    expect(seed.records.some(r => (r.system as string) === 'laser')).toBe(false);
    for (const name of ['laser', '레이저대공무기', '레이저 대공무기 모드', '천광', 'DragonFire']) expect(resolveSystem(name), name).toBeNull();
    expect(resolveSystem('대공미사일')).toBe('sam');
  });
  it('도구 설명, 화면 맥락, 조사 양식이 laser를 받지 않는다', () => {
    const setMap = TOOL_DEFS.find(t => t.name === 'set_map_state')!;
    expect(setMap.properties.system.description).toContain('IFV');
    expect(setMap.properties.system.description).not.toContain('레이저');
    expect(setMap.properties.system.description).not.toContain('장갑차');
    expect(SCREEN_RULE).not.toContain('레이저');
    expect(appContextSchema.shape.mode.safeParse('laser').success).toBe(false);
    expect(recordSchema.safeParse({ id: 'X', country: 'GBR', system: 'laser', batches: [], src: [] }).success).toBe(false);
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
      expect(await second.all("SELECT * FROM records WHERE system='laser'")).toEqual([]);
      expect((await second.all('SELECT * FROM system_links WHERE is_group=1')).length).toBe(6);
      expect(await second.revision()).toBe(1);
    } finally { await second.close(); }
  });
  it('남은 laser 행은 앱이 읽지 않고, 008은 laser 행과 레이저 전용 출처를 지운다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-laser-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
    try {
      await insertLaserRows(repo);
      await repo.run("UPDATE metadata SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='revision'");
      const data = (await repo.versionedData()).data;
      expect(Object.keys(data.systems)).not.toContain('laser');
      expect(data.records.some(r => (r.system as string) === 'laser')).toBe(false);
      expect((await selectRows(repo, 'system_links')).some(r => (r.system as string) === 'laser')).toBe(false);
      expect(await selectRows(repo, 'export_tiers', { country: 'GBR', system: 'laser' })).toEqual([]);
      expect(await selectRows(repo, 'domestic_capability', { system: 'laser' })).toEqual([]);

      const before = await repo.revision();
      await repo.run('DELETE FROM schema_migrations WHERE version=8');
      repo.db.exec(readFileSync(join(process.cwd(), 'db', 'migrations', '008_remove_laser.sql'), 'utf8'));
      for (const table of ['records', 'system_links', 'domestic_capability', 'export_tiers']) expect(await repo.all(`SELECT * FROM ${table} WHERE system='laser'`), table).toEqual([]);
      expect(await repo.all("SELECT * FROM systems WHERE id='laser'")).toEqual([]);
      expect(await repo.all("SELECT * FROM sources WHERE id IN ('gbr_dragonfire','kor_cheongwang')")).toEqual([]);
      expect(await repo.revision()).toBe(before + 1);
      expect(await repo.schemaVersions()).toContain(8);
    } finally { await repo.close(); }
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
