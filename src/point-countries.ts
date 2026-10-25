import type { CountryFeature } from './globe';

/** 점 표시 반지름(위도 기준 도). 지도 경계가 없는 작은 국가를 손가락이나 커서로 고를 수 있는 최소 크기 */
export const POINT_RADIUS_DEG = 0.6;

interface CatalogPoint { id: string; ko: string; en: string; lat: number; lon: number }

/**
 * 국가 카탈로그에는 있지만 지도 경계(Natural Earth 1:110m)가 없는 국가(싱가포르, 바레인 등)를
 * 카탈로그 중심 좌표에 작은 원으로 만든다. 경계 국가와 같은 색 규칙, 선택, 호버를 그대로 쓰도록 같은 형태로 돌려준다.
 */
export function pointCountryFeatures(features: readonly Pick<CountryFeature, 'id'>[], catalog: readonly CatalogPoint[], radius = POINT_RADIUS_DEG): CountryFeature[] {
  const shaped = new Set(features.map(f => f.id));
  return catalog
    .filter(c => !shaped.has(c.id) && Number.isFinite(c.lat) && Number.isFinite(c.lon))
    .map(c => ({ id: c.id, ko: c.ko, en: c.en, point: true, p: [[circle(c.lon, c.lat, radius)]] }));
}

function circle(lon: number, lat: number, radius: number) {
  const ring: number[][] = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i % 24) / 24 * 2 * Math.PI;
    ring.push([lon + Math.cos(a) * radius, lat + Math.sin(a) * radius]);
  }
  return ring;
}
