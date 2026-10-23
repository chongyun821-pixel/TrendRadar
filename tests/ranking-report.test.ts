import { describe, expect, it } from 'vitest';
import type { Forecast, Seed, SystemKey } from '../shared/types';
import { annualRevenue, rankByWindow, rankCountriesByRevenue, revenueMix } from '../src/ranking-report';

const item = (country: string, window: [number, number] | null, score = 0, status: Forecast['status'] = 'open') =>
  ({ country, countryKo: country, systemKo: '자주포', window, score, status } as Forecast);

describe('수주 도래 순위', () => {
  it('시기 미확인을 제외하고 시작·종료 연도와 임박도 순으로 정렬한다', () => {
    const rows = [item('뒤', [2028, 2030]), item('미확인', null), item('동점 낮음', [2026, 2028], 40), item('먼 종료', [2026, 2032], 90), item('동점 높음', [2026, 2028], 80)];
    expect(rankByWindow(rows, 3).map(f => f.country)).toEqual(['동점 높음', '동점 낮음', '먼 종료']);
    expect(rows[0].country).toBe('뒤');
  });

  it('일정이 없는 완료 항목을 포함하지 않는다', () => {
    expect(rankByWindow([item('완료', [2026, 2027], 100, 'none'), item('예정', [2030, 2032])], 5).map(f => f.country)).toEqual(['예정']);
  });

  it('국가를 표시할 무기 TOP 3의 예상 수주액 합계 순으로 정렬한다', () => {
    const row = (country: string, amount: number | null, year: number) => ({ ...item(country, [year, year + 1]), krw: amount == null ? null : [amount, amount] } as Forecast);
    const data = { countries: { A: { ko: '가' }, B: { ko: '나' }, C: { ko: '다' } } } as unknown as Seed;
    const ranked = rankCountriesByRevenue([
      row('A', 100, 2026), row('A', 100, 2027), row('A', 100, 2028), row('A', 1000, 2029),
      row('B', 200, 2026), row('C', null, 2026),
    ], data);
    expect(ranked.map(({ country, revenue }) => [country, revenue])).toEqual([['A', 300], ['B', 200], ['C', 0]]);
  });

  it('향후 3년 내 TOP 5 금액만 기간 비율대로 합산하고 한화 관련 체계만 사용한다', () => {
    const make = (system: SystemKey, country: string, year: number, krw: [number, number] | null) =>
      ({ ...item(country, [year, year + 2]), system, krw } as Forecast);
    const systems = { sph: { hanwha: ['K9'] }, ifv: { hanwha: [] }, sam: { hanwha: ['천궁'] } } as unknown as Seed['systems'];
    const data = { systems, meta: { baseYear: 2026 } } as Seed;
    const rows = [
      make('sph', 'A', 2026, [100, 200]), make('sph', 'B', 2027, null),
      make('sph', 'C', 2028, [50, 70]), make('sph', 'D', 2029, [10, 20]),
      make('sph', 'E', 2030, [10, 20]), make('sph', 'F', 2031, [900, 900]),
      make('ifv', 'G', 2026, [500, 600]), make('sam', 'H', 2026, [40, 60]),
    ];
    const mix = revenueMix(rows, data, 2026);
    expect(mix.unknown).toBe(1);
    expect(mix.slices.map(({ system, count }) => ({ system, count }))).toEqual([{ system: 'sph', count: 2 }, { system: 'sam', count: 1 }]);
    expect(mix.slices[0].low).toBeCloseTo(100 + 50 / 3);
    expect(mix.slices[0].high).toBeCloseTo(200 + 70 / 3);
    expect(mix.slices[0].midpoint).toBeCloseTo(170);
    expect(mix.slices[1].midpoint).toBeCloseTo(50);
    const annual = annualRevenue(rows, data, 2026);
    expect(annual.years).toHaveLength(25);
    expect(annual.years[0]).toBe(2026);
    expect(annual.years.at(-1)).toBe(2050);
    expect(annual.series.map(line => line.system)).toEqual(['sph', 'sam']);
    expect(annual.series[0].amounts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(240);
    expect(annual.series[1].amounts.reduce((sum, value) => sum + value, 0)).toBeCloseTo(50);
    expect(annual.series[0].amounts[0]).toBeCloseTo(50);
  });

});
