import { procurementCoverage } from '../shared/completeness';
import { computeForecast } from '../shared/forecast';
import { landNeighbors, type GeoFeature } from '../shared/tension';
import type { Seed, SystemKey } from '../shared/types';

/** 색상은 무기체계, 농도는 교체 임박도, 흐림은 자료 충실도를 나타낸다. */
export const SYSTEM_COLOR: Record<SystemKey, string> = {
  sph: '#f97316', ifv: '#14b8a6', sam: '#a78bfa', mrl: '#ec4899',
  frigate: '#38bdf8', ssk: '#eab308', laser: '#84cc16',
};
export type Rgb = [number, number, number];
export const UNKNOWN_COLOR = '#929ba8';
export const MISSING_RGB: Rgb = [0.075, 0.105, 0.14];
// 흰색으로 희석하지 않고 지도 바탕 위에서 농도를 낮춰 기둥과 같은 원색을 유지한다.
const TINT_BASE: Rgb = [0.10, 0.13, 0.18];
export const hexRgb = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const mix = (a: Rgb, b: Rgb, k: number): Rgb => a.map((v, i) => v + (b[i] - v) * k) as Rgb;
export const rgbCss = (rgb: Rgb) => `rgb(${rgb.map(v => Math.round(v * 255)).join(',')})`;

export function urgencyIntensity(remaining: number | null) {
  if (remaining == null) return 0;
  if (remaining <= 2) return 1;
  if (remaining <= 5) return 0.88;
  if (remaining <= 10) return 0.74;
  return 0.60;
}
export function systemTint(system: SystemKey, remaining: number | null, partial = false): Rgb {
  if (remaining == null) return hexRgb(UNKNOWN_COLOR);
  return mix(TINT_BASE, hexRgb(SYSTEM_COLOR[system]), urgencyIntensity(remaining) * (partial ? 0.70 : 1));
}

export interface CountryMapStyle {
  rgb: Rgb;
  coverage: 'ready' | 'partial' | 'missing';
  hatched: boolean;
  /** 실제 자료가 충분한 직접 육상 인접국만 포함한다. 참고 표시를 재전파하지 않는다. */
  neighbors: string[];
  remaining: number | null;
}

export function mapCountryStyles(data: Seed, system: SystemKey, geography: GeoFeature[], borders = landNeighbors(geography)) {
  const styles = new Map<string, CountryMapStyle>();
  const records = new Map(data.records.filter(r => r.system === system).map(r => [r.country, r]));
  for (const country of new Set([...geography.map(f => f.id), ...records.keys()])) {
    const record = records.get(country);
    const forecast = record ? computeForecast(record, data) : null;
    const hasData = !!(forecast?.current || forecast?.window || forecast?.nSources || record?.projects?.length || record?.signals?.length || record?.analysis?.facts.length);
    const coverage = !hasData ? 'missing' : procurementCoverage(record, data, system).status === 'ready' && forecast?.confidence !== '하' ? 'ready' : 'partial';
    styles.set(country, {
      rgb: coverage === 'missing' ? [...MISSING_RGB] : systemTint(system, forecast?.remaining ?? null, coverage === 'partial'),
      coverage, hatched: false, neighbors: [], remaining: forecast?.remaining ?? null,
    });
  }
  // 먼저 실제 자료 충실도를 고정한 뒤 빈 나라만 표시한다. 바다 건너 나라와 중복 쌍은 세지 않는다.
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
    style.neighbors = [...(adjacency.get(country) ?? [])].filter(id => styles.get(id)?.coverage === 'ready').sort();
    if (style.neighbors.length >= 2) {
      style.hatched = true;
      style.rgb = hexRgb(SYSTEM_COLOR[system]);
    }
  }
  return styles;
}
