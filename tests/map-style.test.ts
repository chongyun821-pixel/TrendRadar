import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { seed } from '../shared/data';
import { geoFeatures, landNeighbors } from '../shared/tension';
import type { ProgramRecord, Seed, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { hexRgb, mapCountryStyles, MISSING_RGB, SYSTEM_COLOR, systemTint, UNKNOWN_COLOR, urgencyIntensity } from '../src/map-style';

const base = new Date().getFullYear();
const square = (id: string, x: number, y = 0) => ({ id, polygons: [[[[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1], [x, y]]]] });
const geography = [square('AAA', 0), square('BBB', 1), square('CCC', 2), square('DDD', 1, 1), square('ISL', 1, 3)];
function record(country: string, remaining = 0, system: SystemKey = 'sph'): ProgramRecord {
  return { id: `${country}_${system}`, country, system, src: ['s1', 's2'],
    batches: [{ model: '현역 장비', introYear: base - 35, qty: 100, src: ['s1'] }],
    plan: { start: base + remaining, end: base + remaining + 2, qty: [60, 100], text: '공개 일정', src: ['s2'] },
  };
}
function data(records: ProgramRecord[]): Seed {
  return { ...seed, records, sources: {
    s1: { t: '장비 자료', u: 'https://example.com/stock', y: base },
    s2: { t: '계획 자료', u: 'https://example.com/plan', y: base },
  } };
}

describe('무기체계별 지도 색과 농도', () => {
  it('기간 경계마다 같은 색의 농도만 바뀌며 임박할수록 진하다', () => {
    expect([-1, 0, 2, 3, 5, 6, 10, 11, 100, null].map(urgencyIntensity)).toEqual([1, 1, 1, 0.88, 0.88, 0.74, 0.74, 0.60, 0.60, 0]);
    systemTint('sph', 0).forEach((v, i) => expect(v).toBeCloseTo(hexRgb(SYSTEM_COLOR.sph)[i], 12));
    for (const system of Object.keys(SYSTEM_COLOR) as SystemKey[]) {
      const saturation = (years: number) => { const rgb = systemTint(system, years); return Math.max(...rgb) - Math.min(...rgb); };
      expect(saturation(0)).toBeGreaterThan(saturation(5));
      expect(saturation(5)).toBeGreaterThan(saturation(10));
      expect(saturation(10)).toBeGreaterThan(saturation(11));
    }
    expect(new Set(Object.values(SYSTEM_COLOR)).size).toBe(SYSTEM_KEYS.length); // 체계마다 다른 색(레이저대공무기 삭제 후 6개)
  });
  it('사업 규모가 색 농도를 덮어쓰지 않는다', () => {
    const a = record('AAA', 4), b = record('CCC', 4);
    b.plan!.qty = [6000, 10000];
    const styles = mapCountryStyles(data([a, b]), 'sph', geography);
    expect(styles.get('AAA')?.coverage).toBe('ready');
    expect(styles.get('AAA')?.rgb).toEqual(styles.get('CCC')?.rgb);
    const future = mapCountryStyles(data([record('AAA', 12)]), 'sph', geography);
    expect(future.get('AAA')?.rgb).toEqual(systemTint('sph', 12));
  });
  it('수량 부족은 같은 색을 연하게, 시기 미확인은 회색, 기록 없음은 바탕색으로 구분한다', () => {
    const a = record('AAA'); a.batches[0].qty = null; a.plan!.qty = null;
    const b = record('CCC'); delete b.plan; b.batches[0].introYear = null;
    const styles = mapCountryStyles(data([a, b]), 'sph', geography);
    expect(styles.get('AAA')).toMatchObject({ coverage: 'partial', rgb: systemTint('sph', 0, true), hatched: false });
    expect(styles.get('CCC')).toMatchObject({ coverage: 'partial', rgb: hexRgb(UNKNOWN_COLOR), remaining: null });
    expect(styles.get('BBB')).toMatchObject({ coverage: 'missing', rgb: MISSING_RGB, hatched: false });
  });
  it('사업 설명만 있거나 근거가 없거나 오래되어 신뢰도가 낮으면 자료 충분으로 보지 않는다', () => {
    const narrative = record('AAA'); narrative.batches = []; delete narrative.plan;
    narrative.projects = [{ id: 'p', buyer: 'AAA', supplier: 'X', stage: 'plan', text: '사업 검토', src: ['s1'] }];
    const unsourced = record('CCC'); unsourced.src = []; unsourced.batches[0].src = []; unsourced.plan!.src = [];
    const styles = mapCountryStyles(data([narrative, unsourced]), 'sph', geography);
    expect(styles.get('AAA')?.coverage).toBe('partial');
    expect(styles.get('CCC')?.coverage).toBe('partial');
    const old = data([record('AAA')]); old.sources.s1.y = old.sources.s2.y = base - 15;
    expect(mapCountryStyles(old, 'sph', geography).get('AAA')?.coverage).toBe('partial');
  });
});

describe('데이터 없는 국가의 인접국 참고 빗금', () => {
  it('같은 체계의 자료 충분 국가 두 곳과 육상 국경이 있어야 빗금으로 표시한다', () => {
    const styles = mapCountryStyles(data([record('AAA'), record('CCC'), record('ISL')]), 'sph', geography);
    expect(styles.get('BBB')).toMatchObject({ coverage: 'missing', hatched: true, rgb: hexRgb(SYSTEM_COLOR.sph), neighbors: ['AAA', 'CCC'], remaining: null });
    expect(styles.get('DDD')?.hatched).toBe(false); // 바다 건너 ISL은 세지 않는다.
    const single = mapCountryStyles(data([record('AAA')]), 'sph', geography);
    expect(single.get('BBB')?.hatched).toBe(false);
    expect(mapCountryStyles(data([record('AAA'), record('CCC', 0, 'ifv')]), 'sph', geography).get('BBB')?.hatched).toBe(false);
  });
  it('중복 쌍, 빗금 표시 국가와 자료 일부인 국가는 두 번째 충분 국가로 세지 않는다', () => {
    const borders: [string, string][] = [['AAA', 'BBB'], ['BBB', 'AAA'], ['AAA', 'BBB'], ['CCC', 'BBB'], ['BBB', 'DDD'], ['AAA', 'DDD']];
    const styles = mapCountryStyles(data([record('AAA'), record('CCC')]), 'sph', geography, borders);
    expect(styles.get('BBB')?.hatched).toBe(true);
    expect(styles.get('DDD')?.hatched).toBe(false); // AAA + 빗금 BBB는 충분 국가 두 곳이 아니다.
    expect(mapCountryStyles(data([record('AAA')]), 'sph', geography, borders).get('BBB')?.hatched).toBe(false);
    const partial = record('CCC'); partial.batches[0].qty = null; partial.plan!.qty = null;
    expect(mapCountryStyles(data([record('AAA'), partial]), 'sph', geography, borders).get('BBB')?.hatched).toBe(false);
  });
  it('자체 자료가 일부라도 있는 국가는 이웃의 참고 빗금으로 덮어쓰지 않는다', () => {
    const partial = record('BBB'); partial.batches[0].qty = null; partial.plan!.qty = null;
    const styles = mapCountryStyles(data([record('AAA'), record('CCC'), partial]), 'sph', geography);
    expect(styles.get('BBB')).toMatchObject({ coverage: 'partial', hatched: false, neighbors: [] });
    const empty = { ...record('BBB'), batches: [], plan: undefined, src: [] };
    expect(mapCountryStyles(data([record('AAA'), record('CCC'), empty]), 'sph', geography).get('BBB')?.hatched).toBe(true);
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
