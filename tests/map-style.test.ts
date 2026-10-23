import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { seed } from '../shared/data';
import { computeForecast } from '../shared/forecast';
import { geoFeatures, landNeighbors } from '../shared/tension';
import type { ProgramRecord, Seed, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { hexRgb, mapCountryStyles, MISSING_RGB, SYSTEM_COLOR, systemTint, urgencyIntensity, timingLabel, leadingWeapons, mapSizes } from '../src/map-style';

const base = seed.meta.baseYear;
const square = (id: string, x: number, y = 0) => ({ id, polygons: [[[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]] });
const geography = [square('AAA', 0), square('BBB', 1), square('CCC', 2), square('DDD', 1, 1), square('ISL', 1, 3)];
function record(country: string, system: SystemKey = 'sph'): ProgramRecord {
  return { id: `${country}_${system}`, country, system, src: ['s1', 's2'],
    batches: [{ model: '현역 장비', introYear: base - 35, qty: 100, src: ['s1'] }],
    plan: { start: base, end: base + 2, qty: [60, 100], text: '공개 일정', src: ['s2'] },
  };
}
function data(records: ProgramRecord[]): Seed {
  return { ...seed, records, sources: {
    s1: { t: '장비 자료', u: 'https://example.com/stock', y: base },
    s2: { t: '계획 자료', u: 'https://example.com/plan', y: base },
  } };
}

describe('자체 자료 유무에 따른 원색·빗금', () => {
  it('각 체계의 자료 있는 국가는 자체 시기에 맞는 단색이며 자료 일부도 빗금을 치지 않는다', () => {
    for (const system of SYSTEM_KEYS) {
      const a = record('AAA', system), c = record('CCC', system);
      c.batches[0].qty = null; c.batches[0].introYear = null; delete c.plan;
      const styles = mapCountryStyles(data([a, c]), system, geography);
      expect(styles.get('AAA')).toMatchObject({ coverage: 'ready', rgb: hexRgb(SYSTEM_COLOR[system]), hatched: false });
      expect(styles.get('CCC')).toMatchObject({ coverage: 'partial', rgb: systemTint(system, null), hatched: false });
    }
    expect(new Set(Object.values(SYSTEM_COLOR)).size).toBe(SYSTEM_KEYS.length);
  });
  it('자료 있는 육상 인접국이 없으면 빗금·순위 없이 바탕색으로 표시한다', () => {
    const styles = mapCountryStyles(data([]), 'sph', geography);
    expect([...styles.values()].every(s => !s.hatched && s.coverage === 'missing' && s.referenceRank === null)).toBe(true);
    expect(styles.get('ISL')).toMatchObject({ rgb: MISSING_RGB, neighbors: [], neighborAmount: null, referenceScore: 0, remaining: null });
    const single = mapCountryStyles(data([record('AAA')]), 'sph', geography);
    expect(single.get('BBB')).toMatchObject({ hatched: true, rgb: hexRgb(SYSTEM_COLOR.sph) }); // DB 미등록도 직접 이웃이면 후보
    expect(single.get('ISL')).toMatchObject({ hatched: false, rgb: MISSING_RGB, referenceRank: null });
  });
  it('빈 레코드는 자료 없음, 사업 설명·출처·일부 장비가 있으면 자료 일부로 구분한다', () => {
    const empty = { ...record('BBB'), batches: [], plan: undefined, src: [] };
    const narrative = { ...empty, country: 'CCC', projects: [{ id: 'p', buyer: 'CCC', supplier: 'X', stage: 'plan' as const, text: '사업 검토', src: [] }] };
    const styles = mapCountryStyles(data([record('AAA'), empty, narrative]), 'sph', geography);
    expect(styles.get('BBB')).toMatchObject({ coverage: 'missing', hatched: true });
    expect(styles.get('CCC')).toMatchObject({ coverage: 'partial', hatched: false });
  });
});

describe('지도 단계·금액 크기·일반 지도 대표 무기', () => {
  it('3년·10년 경계에서 100/50/20%로 구분하고 미확인은 별도로 유지한다', () => {
    expect([-1, 0, 3, 4, 10, 11, 100, null].map(urgencyIntensity)).toEqual([1, 1, 1, 0.5, 0.5, 0.2, 0.2, 0.35]);
    expect([3, 10, 11, null].map(timingLabel)).toEqual(['3년 이내', '10년 이내', '10년 이후', '시기 미확인']);
    const records = ['AAA', 'BBB', 'CCC'].map(country => record(country));
    records[1].plan!.start = base + 10; records[2].plan!.start = base + 11;
    const styles = mapCountryStyles(data(records), 'sph', geography);
    expect(styles.get('AAA')!.rgb[0] / styles.get('BBB')!.rgb[0]).toBe(2);
    expect(styles.get('BBB')!.rgb[0] / styles.get('CCC')!.rgb[0]).toBeCloseTo(2.5);
  });
  it('금액은 표시 국가의 최대값으로 정규화 후 로그 변환하며 순서와 화폐 단위에 무관하다', () => {
    const fixture = data([record('AAA'), record('BBB'), record('CCC')]);
    const forecasts = fixture.records.map(r => computeForecast(r, fixture));
    forecasts.forEach((f, i) => { f.krw = [10 ** i, 10 ** i]; });
    const sizes = mapSizes(forecasts);
    expect(sizes.get('AAA')).toBeGreaterThan(0);
    expect(sizes.get('AAA')).toBeLessThan(sizes.get('BBB')!);
    expect(sizes.get('BBB')).toBeLessThan(sizes.get('CCC')!);
    expect(sizes.get('CCC')).toBeCloseTo(1);
    const scaled = mapSizes(forecasts.map(f => ({ ...f, krw: f.krw!.map(v => v * 1000) as [number, number] })).reverse());
    expect(scaled.get('AAA')).toBeCloseTo(sizes.get('AAA')!);
    expect(scaled.get('BBB')).toBeCloseTo(sizes.get('BBB')!);
  });
  it('같은 금액은 같은 크기이며 미확인·잘못된 금액을 크기값으로 만들지 않는다', () => {
    const f = computeForecast(record('AAA'), data([]));
    expect(mapSizes([{ ...f, krw: null }]).has('AAA')).toBe(false);
    expect(mapSizes([{ ...f, krw: [NaN, 10] }]).has('AAA')).toBe(false);
    expect(mapSizes([{ ...f, krw: [0, 0] }]).get('AAA')).toBe(0);
    const sizes = mapSizes([{ ...f, krw: [10, 20] }, { ...f, country: 'BBB', krw: [10, 20] }]);
    expect(sizes.get('AAA')).toBe(sizes.get('BBB'));
  });
  it('일반 지도는 실제 점수가 가장 높은 무기를 고르고 제외·자료 없음·미확인 점수는 건너뛴다', () => {
    const fixture = data([record('AAA'), record('AAA', 'mrl'), record('BBB')]);
    const best = leadingWeapons(fixture, [
      { country: 'AAA', system: 'sph', score: 70, grey: false },
      { country: 'AAA', system: 'mrl', score: 90, grey: false },
      { country: 'AAA', system: 'ifv', score: 100, grey: false },
      { country: 'BBB', system: 'sph', score: 100, grey: true },
      { country: 'CCC', system: 'sph', score: 100, grey: false },
    ]);
    expect(best.get('AAA')?.system).toBe('mrl');
    expect(best.has('BBB')).toBe(false); expect(best.has('CCC')).toBe(false);
    expect(leadingWeapons(fixture, []).size).toBe(0);
    const ties = [
      { country: 'AAA', system: 'mrl' as const, score: 70, grey: false },
      { country: 'AAA', system: 'sph' as const, score: 70, grey: false },
    ];
    expect(leadingWeapons(fixture, ties).get('AAA')?.system).toBe('sph');
    expect(leadingWeapons(fixture, ties.reverse()).get('AAA')?.system).toBe('sph');
  });
});

describe('같은 체계의 자료 있는 육상 인접국 참고 점수', () => {
  it('인접국 한 곳만 있어도 세며 다른 무기체계와 바다 건너 국가는 세지 않는다', () => {
    const styles = mapCountryStyles(data([record('AAA'), record('CCC', 'ifv'), record('ISL')]), 'sph', geography);
    expect(styles.get('BBB')).toMatchObject({ neighbors: ['AAA'], hatched: true });
    expect(styles.get('DDD')).toMatchObject({ neighbors: [], referenceScore: 0, hatched: false, referenceRank: null });
  });
  it('자료 일부·신뢰도 하도 세지만 중복 국경·자기 자신·자료 없는 국가는 세지 않는다', () => {
    const partial = record('CCC'); partial.batches[0].qty = null; partial.plan!.qty = null;
    const borders: [string, string][] = [['AAA', 'BBB'], ['BBB', 'AAA'], ['AAA', 'BBB'], ['BBB', 'BBB'], ['CCC', 'BBB'], ['BBB', 'DDD'], ['AAA', 'DDD'], ['ZZZ', 'BBB']];
    const styles = mapCountryStyles(data([record('AAA'), partial]), 'sph', geography, borders);
    expect(styles.get('BBB')?.neighbors).toEqual(['AAA', 'CCC']);
    expect(styles.get('DDD')?.neighbors).toEqual(['AAA']);
    expect(styles.get('BBB')!.referenceScore).toBeGreaterThan(styles.get('DDD')!.referenceScore);
  });
  it('인접국 수와 금액이 각각 증가하면 점수가 높아지고 합계는 같은 체계 금액만 포함한다', () => {
    const a = record('AAA'), c = record('CCC'); c.plan!.qty = [600, 1000];
    const fixture = data([a, c, record('ISL', 'ifv')]);
    const map = [...geography, square('EEE', 9), square('FFF', 11)];
    const styles = mapCountryStyles(fixture, 'sph', map, [['AAA', 'BBB'], ['CCC', 'DDD'], ['AAA', 'EEE'], ['CCC', 'EEE'], ['ISL', 'FFF']]);
    const score = (id: string) => styles.get(id)!.referenceScore;
    expect(score('DDD')).toBeGreaterThan(score('BBB'));
    expect(score('EEE')).toBeGreaterThan(score('DDD'));
    expect(score('EEE')).toBe(100);
    expect(score('FFF')).toBe(0);
    const amounts = [a, c].map(r => computeForecast(r, fixture).krw!);
    expect(styles.get('EEE')!.neighborAmount).toEqual([amounts[0][0] + amounts[1][0], amounts[0][1] + amounts[1][1]]);
  });
  it('미확인 금액은 null로 보존하고 인접국 수에만 반영한다', () => {
    const a = record('AAA'); a.plan!.qty = null; a.batches[0].qty = null;
    const styles = mapCountryStyles(data([a]), 'sph', geography);
    expect(styles.get('BBB')).toMatchObject({ neighbors: ['AAA'], neighborAmount: null, referenceScore: 50 });
    expect([...styles.values()].every(s => Number.isFinite(s.referenceScore))).toBe(true);
  });
  it('5개국을 넘겨도 모든 후보가 같은 빗금이며 입력 순서가 달라도 동점 순위가 같다', () => {
    const missing = Array.from({ length: 8 }, (_, i) => square(`M0${i}`, i * 3));
    const map = [square('AAA', -10), ...missing];
    const borders: [string, string][] = missing.map(f => ['AAA', f.id]);
    const first = mapCountryStyles(data([record('AAA')]), 'sph', map, borders);
    const reversed = mapCountryStyles(data([record('AAA')]), 'sph', [...map].reverse(), [...borders].reverse());
    const ranked = (styles: ReturnType<typeof mapCountryStyles>) => [...styles].filter(([, s]) => s.referenceRank != null).sort(([, a], [, b]) => a.referenceRank! - b.referenceRank!).map(([id]) => id);
    expect([...first.values()].filter(s => s.hatched)).toHaveLength(8);
    expect(ranked(first)).toEqual(missing.map(f => f.id));
    expect(ranked(reversed)).toEqual(ranked(first));
    expect(first.get('M05')).toMatchObject({ hatched: true, referenceRank: 6 });
    expect(first.get('AAA')?.referenceRank).toBeNull();
  });
  it('자료가 바뀌면 후보·순위가 갱신되고 지도에 없는 빈 레코드는 순위에서 제외한다', () => {
    const map = [square('AAA', -10), ...Array.from({ length: 6 }, (_, i) => square(`M0${i}`, i * 3))];
    const empty = { ...record('AAB'), batches: [], plan: undefined, src: [] };
    const before = mapCountryStyles(data([record('AAA'), empty]), 'sph', map, []);
    expect(before.get('AAB')?.referenceRank).toBeNull();
    expect(before.get('M05')).toMatchObject({ hatched: false, referenceRank: null });
    const after = mapCountryStyles(data([record('AAA'), empty]), 'sph', map, [['AAA', 'M05']]);
    expect(after.get('M05')).toMatchObject({ referenceRank: 1, hatched: true, referenceScore: 100 });
    expect([...after.values()].filter(s => s.hatched)).toHaveLength(1);
    const removed = mapCountryStyles(data([]), 'sph', map, [['AAA', 'M05']]);
    expect(removed.get('M05')).toMatchObject({ hatched: false, referenceRank: null, rgb: MISSING_RGB });
  });
  it('화면용 경계의 국경 313쌍이 원본과 같고 해상 인접국은 제외된다', () => {
    const raw = JSON.parse(readFileSync('data/ne_110m_admin_0_countries.geojson', 'utf8'));
    const slim = JSON.parse(readFileSync('public/countries.json', 'utf8')).map((f: { id: string; p: number[][][][] }) => ({ id: f.id, polygons: f.p }));
    const pairs = landNeighbors(slim).map(p => p.join('|')).sort();
    expect(pairs).toEqual(landNeighbors(geoFeatures(raw)).map(p => p.join('|')).sort());
    expect(pairs).toHaveLength(313);
    expect(pairs).toContain('KOR|PRK');
    expect(pairs).not.toContain('CHN|KOR');
    expect(pairs).not.toContain('FRA|GBR');
  });
});
