import { procurementCoverage } from '../shared/completeness';
import { computeForecast } from '../shared/forecast';
import { landNeighbors, type GeoFeature } from '../shared/tension';
import type { Forecast, ProgramRecord, Seed, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';

/** 자체 자료는 원색, 자료 있는 인접국을 둔 미조사 국가는 빗금, 나머지는 바탕색이다. */
export const SYSTEM_COLOR: Record<SystemKey, string> = {
  sph: '#f97316', ifv: '#14b8a6', sam: '#a78bfa', mrl: '#ec4899',
  frigate: '#38bdf8', ssk: '#eab308',
};
export type Rgb = [number, number, number];
export const MISSING_RGB: Rgb = [0.075, 0.105, 0.14];
export const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export const rgbCss = (rgb: Rgb) => `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;

export function urgencyIntensity(remaining: number | null) {
  return remaining == null ? 0.35 : remaining <= 3 ? 1 : remaining <= 10 ? 0.5 : 0.2;
}
export function systemTint(system: SystemKey, remaining: number | null): Rgb {
  const intensity = urgencyIntensity(remaining);
  return hexRgb(SYSTEM_COLOR[system]).map(v => v * intensity) as Rgb;
}
export const timingLabel = (remaining: number | null) => remaining == null ? '시기 미확인' : remaining <= 3 ? '3년 이내' : remaining <= 10 ? '10년 이내' : '10년 이후';

export interface WeaponScore { country: string; system: SystemKey; score: number; grey: boolean; gate?: string | null }
function hasOwnData(record: ProgramRecord | undefined, forecast: Forecast | null) {
  return !!(forecast?.current || forecast?.window || forecast?.nSources || record?.projects?.length || record?.signals?.length || record?.analysis?.facts.length);
}
/** 일반 지도는 실제 종합 점수와 자체 자료가 모두 있는 무기 중 최고점을 고른다. */
export function leadingWeapons(data: Seed, scores: Iterable<WeaponScore>) {
  const known = new Set(data.records.filter(r => hasOwnData(r, computeForecast(r, data))).map(r => `${r.system}:${r.country}`));
  const best = new Map<string, WeaponScore>();
  for (const row of scores) {
    if (row.grey || !Number.isFinite(row.score) || !known.has(`${row.system}:${row.country}`)) continue;
    const previous = best.get(row.country);
    if (!previous || row.score > previous.score || row.score === previous.score && SYSTEM_KEYS.indexOf(row.system) < SYSTEM_KEYS.indexOf(previous.system)) best.set(row.country, row);
  }
  return best;
}
/** 화면에 표시할 국가끼리 최대 금액으로 정규화한 다음 로그를 적용한다. */
export function mapSizes(forecasts: Forecast[]) {
  const amounts = forecasts.filter(f => f.krw && f.krw.every(v => Number.isFinite(v) && v >= 0)).map(f => [f.country, (f.krw![0] + f.krw![1]) / 2] as const);
  const max = Math.max(0, ...amounts.map(([, amount]) => amount));
  return new Map(amounts.map(([country, amount]) => [country, max > 0 ? Math.log1p(9 * amount / max) / Math.log(10) : 0]));
}

export interface CountryMapStyle {
  rgb: Rgb;
  coverage: 'ready' | 'partial' | 'missing';
  hatched: boolean;
  /** 같은 체계의 자체 자료가 있는 직접 육상 인접국만 포함한다. 빗금 국가는 세지 않는다. */
  neighbors: string[];
  /** 인접국의 확인 가능한 예상 사업 금액 합계(억 원). 미확인은 null로 보존한다. */
  neighborAmount: [number, number] | null;
  referenceScore: number;
  referenceRank: number | null;
  remaining: number | null;
}

export function mapCountryStyles(data: Seed, system: SystemKey, geography: GeoFeature[], borders = landNeighbors(geography)) {
  const styles = new Map<string, CountryMapStyle>();
  const records = new Map(data.records.filter(r => r.system === system).map(r => [r.country, r]));
  const amounts = new Map<string, [number, number]>();
  for (const country of new Set([...geography.map(f => f.id), ...records.keys()])) {
    const record = records.get(country);
    const forecast = record ? computeForecast(record, data) : null;
    const hasData = hasOwnData(record, forecast);
    const coverage = !hasData ? 'missing' : procurementCoverage(record, data, system).status === 'ready' && forecast?.confidence !== '하' ? 'ready' : 'partial';
    if (hasData && forecast?.krw?.every(v => Number.isFinite(v) && v >= 0)) amounts.set(country, forecast.krw);
    styles.set(country, {
      rgb: coverage === 'missing' ? [...MISSING_RGB] : systemTint(system, forecast?.remaining ?? null),
      coverage, hatched: false, neighbors: [],
      neighborAmount: null, referenceScore: 0, referenceRank: null, remaining: forecast?.remaining ?? null,
    });
  }
  // 자체 자료 판정을 먼저 고정한다. 바다 건너 국가, 중복 국경, 빗금 국가는 인접국 수에 더하지 않는다.
  const adjacency = new Map<string, Set<string>>();
  for (const [a, b] of borders) {
    if (a === b) continue;
    for (const [country, neighbor] of [[a, b], [b, a]]) {
      if (!adjacency.has(country)) adjacency.set(country, new Set());
      adjacency.get(country)!.add(neighbor);
    }
  }
  for (const [country, style] of styles) {
    if (style.coverage !== 'missing') continue;
    style.neighbors = [...(adjacency.get(country) ?? [])].filter(id => {
      const neighbor = styles.get(id);
      return neighbor && neighbor.coverage !== 'missing';
    }).sort();
    if (style.neighbors.length) {
      style.hatched = true;
      style.rgb = hexRgb(SYSTEM_COLOR[system]);
    }
    const knownAmounts = style.neighbors.flatMap(id => amounts.has(id) ? [amounts.get(id)!] : []);
    if (knownAmounts.length) style.neighborAmount = knownAmounts.reduce<[number, number]>((sum, amount) => [sum[0] + amount[0], sum[1] + amount[1]], [0, 0]);
  }
  // 빗금 후보끼리 비교한다. 수, 금액 각각 최대값 대비 비율에 50점씩 준다.
  const mapped = new Set(geography.map(f => f.id));
  const missing = [...styles].filter(([id, style]) => mapped.has(id) && style.hatched);
  const midpoint = (style: CountryMapStyle) => style.neighborAmount ? (style.neighborAmount[0] + style.neighborAmount[1]) / 2 : 0;
  const maxCount = Math.max(1, ...missing.map(([, style]) => style.neighbors.length));
  const maxAmount = Math.max(0, ...missing.map(([, style]) => midpoint(style)));
  for (const [, style] of missing) style.referenceScore = 50 * style.neighbors.length / maxCount + (maxAmount > 0 ? 50 * midpoint(style) / maxAmount : 0);
  // 동점은 금액, 인접국 수, 국가 코드 순으로 정한다. 순위는 카드에서만 표시한다.
  missing.sort(([a, x], [b, y]) => y.referenceScore - x.referenceScore || midpoint(y) - midpoint(x) || y.neighbors.length - x.neighbors.length || a.localeCompare(b));
  missing.forEach(([, style], i) => { style.referenceRank = i + 1; });
  return styles;
}
