/** 인접국 쌍과 긴장도(0~100) 자동 산출 (요구서 5장). 지리 계산과 점수식은 순수 함수다. */
import type { BudgetRow, PairEventRow, SignalRow } from './types';
import { growth3y } from './forecast';
import { isRecent } from './base-year';

export const TENSION_WEIGHTS = { conflict: 35, events: 25, arms: 20, territory: 20 } as const;
export const ALLIANCE_DISCOUNT = 0.3;
/** 해상 인접 기준 거리(km). 1:110m 경계의 꼭짓점 간 거리라 실제 해안선보다 다소 길게 잡는다 */
export const SEA_NEIGHBOR_KM = 400;
/**
 * 근거가 하나도 없는 쌍(UCDP·GDELT·분쟁 목록·구매 신호·국방비 증가율 모두 없음)의 긴장도 추정 규칙.
 * 같은 산출에서 근거가 있는 쌍의 긴장도 중앙값을 쓴다(두 나라 중 한쪽이 들어간 쌍 우선, 없으면 전체). 근거 있는 쌍이 하나도 없으면 DEFAULT.
 * 같은 동맹이면 30% 감산하고, 신뢰도는 CONFIDENCE(정적 분쟁 목록 0.4보다 낮음)로 둔다.
 */
export const TENSION_ESTIMATE = { DEFAULT: 10, CONFIDENCE: 0.2 } as const;

export interface GeoFeature { id: string; polygons: number[][][][] } // [폴리곤][링][점][lon,lat]
/** Natural Earth GeoJSON → 국가 ID(ADM0_A3, 앱 지도와 같은 ID)별 폴리곤 */
export function geoFeatures(geojson: { features: { properties: Record<string, any>; geometry: { type: string; coordinates: any } }[] }): GeoFeature[] {
  return geojson.features.filter(f => f.geometry).map(f => ({ id: f.properties.ADM0_A3, polygons: f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates] }));
}
const pointKey = (p: number[]) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
/** 내륙국(해상 인접에서 제외). 카스피해 연안국도 해양 경계가 없는 것으로 본다 */
export const LANDLOCKED = new Set(['AFG','AND','ARM','AUT','AZE','BLR','BOL','BWA','BFA','BDI','CAF','TCD','CZE','SWZ','ETH','HUN','KAZ','KOS','KGZ','LAO','LSO','LIE','LUX','MWI','MLI','MDA','MNG','NPL','NER','MKD','PRY','RWA','SMR','SRB','SVK','SSD','TJK','TKM','UGA','UZB','VAT','ZMB','ZWE','CHE']);
/** 육상 국경: 두 나라 경계가 꼭짓점 2개 이상을 공유하면 인접으로 본다(Natural Earth는 공통 경계를 같은 좌표로 저장, 삼국 접점 하나만 닿는 쌍은 제외) */
export function landNeighbors(features: GeoFeature[]): [string, string][] {
  const owners = new Map<string, Set<string>>();
  for (const f of features) for (const poly of f.polygons) for (const ring of poly) for (const p of ring) {
    const k = pointKey(p); if (!owners.has(k)) owners.set(k, new Set()); owners.get(k)!.add(f.id);
  }
  const shared = new Map<string, number>();
  for (const ids of owners.values()) if (ids.size > 1) { const list = [...ids].sort(); for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const k = `${list[i]}|${list[j]}`; shared.set(k, (shared.get(k) || 0) + 1); } }
  return [...shared].filter(([, n]) => n >= 2).map(([p]) => p.split('|') as [string, string]);
}
export function haversineKm(a: number[], b: number[]) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** 해상 인접: 내륙국이 아니고 육상 국경이 없으며 경계 꼭짓점 사이 최소 거리가 km 이내인 쌍 */
export function seaNeighbors(features: GeoFeature[], km = SEA_NEIGHBOR_KM, land: [string, string][] = landNeighbors(features)): { pair: [string, string]; km: number }[] {
  const landSet = new Set(land.map(p => [...p].sort().join('|')));
  const pts = features.filter(f => !LANDLOCKED.has(f.id)).map(f => { const all = f.polygons.flat(2); return { id: f.id, all, box: [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))] }; });
  const pad = km / 111 + 1, out: { pair: [string, string]; km: number }[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const a = pts[i], b = pts[j];
    if (a.id === b.id || landSet.has([a.id, b.id].sort().join('|'))) continue;
    // 경계 상자로 먼저 거른다. 날짜변경선에 걸친 나라(러시아·미국·피지 등)는 상자가 경도 전체를 덮어 통과한다
    const lonPad = pad / Math.max(0.2, Math.cos(Math.min(80, Math.max(Math.abs(a.box[1]), Math.abs(a.box[3]))) * Math.PI / 180));
    if (a.box[1] - pad > b.box[3] || b.box[1] - pad > a.box[3] || a.box[0] - lonPad > b.box[2] || b.box[0] - lonPad > a.box[2]) continue;
    let min = Infinity;
    for (const p of a.all) { for (const q of b.all) { const d = haversineKm(p, q); if (d < min) min = d; } if (min < 1) break; }
    if (min <= km) out.push({ pair: [a.id, b.id].sort() as [string, string], km: Math.round(min) });
  }
  return out;
}
/** 최근 5년 GDELT 적대 이벤트 상위 국가를 경쟁국으로 더한다 */
export function rivals(events: PairEventRow[], top = 3, minEvents = 50, since?: string): [string, string][] {
  const sum = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.source !== 'gdelt' || e.country === e.counterpart || (since && e.period < since)) continue;
    for (const [a, b] of [[e.country, e.counterpart], [e.counterpart, e.country]]) {
      if (!sum.has(a)) sum.set(a, new Map());
      sum.get(a)!.set(b, (sum.get(a)!.get(b) || 0) + (e.events || 0));
    }
  }
  const pairs = new Set<string>();
  for (const [a, m] of sum) for (const [b, n] of [...m].sort((x, y) => y[1] - x[1]).slice(0, top)) if (n >= minEvents) pairs.add([a, b].sort().join('|'));
  return [...pairs].map(p => p.split('|') as [string, string]);
}

export interface Dispute { a: string; b: string; name: string; intensity: number; url?: string }
export interface Alliance { name: string; members: string[] }
export interface PairInputs {
  country: string; neighbor: string; base: number;
  events: PairEventRow[]; budgets: BudgetRow[]; signals: SignalRow[];
  disputes: Dispute[]; alliances: Alliance[];
}
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const r1 = (n: number) => Math.round(n * 10) / 10;
const pairOf = (e: PairEventRow, a: string, b: string) => (e.country === a && e.counterpart === b) || (e.country === b && e.counterpart === a);
const monthsBack = (base: string, n: number) => { const [y, m] = base.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 - n, 1)); return d.toISOString().slice(0, 7); };

/**
 * 긴장도 = 무력 충돌 35 + 적대 이벤트 25 + 군비 경쟁 20 + 영토 분쟁 20, 같은 동맹이면 30% 감산.
 * 각 요소는 0~1 원점수와 근거 ID를 components에 남긴다.
 */
export function computeTension(p: PairInputs, asOf = `${p.base}-12`) {
  const { country: a, neighbor: b } = p;
  // 충돌·구매는 '최근 3년'(기준 연도 포함 4개년, base-3..base), 적대 이벤트는 asOf까지 12개월
  const ucdp = p.events.filter(e => e.source.startsWith('ucdp') && pairOf(e, a, b) && isRecent(Number(e.period), p.base));
  const fatal = ucdp.reduce((s, e) => s + (e.fatalities || 0), 0);
  const conflict = clamp01(Math.log10(1 + fatal) / 3); // 1,000명 이상이면 최대
  const from = monthsBack(asOf, 11);
  const gd = p.events.filter(e => e.source === 'gdelt' && pairOf(e, a, b) && e.period >= from && e.period <= asOf);
  const n = gd.reduce((s, e) => s + (e.events || 0), 0);
  const gold = n ? gd.reduce((s, e) => s + (e.goldstein || 0) * (e.events || 0), 0) / n : 0;
  const events = gd.length ? clamp01(0.6 * Math.log10(1 + n) / Math.log10(5001) + 0.4 * clamp01(-gold / 10)) : 0;
  const ga = growth3y(p.budgets.filter(x => x.country === a), p.base), gb = growth3y(p.budgets.filter(x => x.country === b), p.base);
  const buys = p.signals.filter(s => (s.country === a || s.country === b) && ['selection', 'contract', 'delivery'].includes(s.stage) && isRecent(Number(String(s.published_at || '').slice(0, 4)) || s.expected_year || 0, p.base));
  const growth = [ga.value, gb.value].filter((v): v is number => v != null);
  const arms = clamp01(0.5 * clamp01((growth.length ? growth.reduce((s, v) => s + v, 0) / growth.length : 0) / 10) + 0.5 * Math.min(1, buys.length / 5));
  const dispute = p.disputes.find(d => (d.a === a && d.b === b) || (d.a === b && d.b === a));
  const territory = clamp01(dispute?.intensity ?? 0);
  const alliance = p.alliances.find(x => x.members.includes(a) && x.members.includes(b));
  const hasEvidence = ucdp.length + gd.length + buys.length + ga.rows.length + gb.rows.length > 0 || !!dispute;
  const W = TENSION_WEIGHTS;
  const before = W.conflict * conflict + W.events * events + W.arms * arms + W.territory * territory;
  const tension = r1(before * (alliance ? 1 - ALLIANCE_DISCOUNT : 1));
  const evidence = (rows: PairEventRow[]) => rows.map(e => `pair_events:${e.source}:${e.country}:${e.counterpart}:${e.period}`);
  return {
    tension,
    components: {
      conflict: { weight: W.conflict, raw: r1(conflict * 100) / 100, points: r1(W.conflict * conflict), fatalities3y: fatal, evidence: evidence(ucdp) },
      events: { weight: W.events, raw: r1(events * 100) / 100, points: r1(W.events * events), hostileEvents12m: n, goldstein: r1(gold), from, to: asOf, evidence: evidence(gd).slice(0, 24) },
      arms: { weight: W.arms, raw: r1(arms * 100) / 100, points: r1(W.arms * arms), growth: { [a]: ga.value == null ? null : r1(ga.value), [b]: gb.value == null ? null : r1(gb.value) }, purchases3y: buys.length, evidence: [...buys.slice(0, 10).map(s => `signals:${s.id}`), ...[...ga.rows, ...gb.rows].map(r => `budgets:${r.country}:${r.year}`)] },
      territory: { weight: W.territory, raw: territory, points: r1(W.territory * territory), dispute: dispute?.name ?? null, evidence: dispute?.url ? [dispute.url] : [] },
      alliance: alliance ? { name: alliance.name, discount: ALLIANCE_DISCOUNT, before: r1(before) } : null,
    },
    /** 근거가 된 자료(충돌·이벤트·구매 신호·국방비)의 최소 신뢰도. 영토 분쟁 정적 목록(위키백과 기준)은 0.4. 근거가 없으면 null(estimateMissingTension이 추정한다) */
    confidence: hasEvidence ? Math.min(...[...ucdp, ...gd, ...buys, ...ga.rows, ...gb.rows].map(e => e.confidence ?? 1), dispute ? 0.4 : 1, 1) : null,
    hasEvidence,
  };
}

/** 근거 없는 쌍에 추정 긴장도를 채운다(TENSION_ESTIMATE 규칙). components.estimated에 추정 근거를 남긴다 */
export function estimateMissingTension<T extends { country: string; neighbor: string; tension: number; confidence: number | null; hasEvidence: boolean; components: Record<string, any> }>(rows: T[]): T[] {
  const known = rows.filter(r => r.hasEvidence);
  const median = (v: number[]) => { const s = [...v].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return rows.map(r => {
    if (r.hasEvidence) return r;
    const near = known.filter(k => [k.country, k.neighbor].some(c => c === r.country || c === r.neighbor));
    const pool = near.length ? near : known;
    const baseline = pool.length ? median(pool.map(k => k.tension)) : TENSION_ESTIMATE.DEFAULT;
    const alliance = r.components.alliance;
    const tension = r1(baseline * (alliance ? 1 - ALLIANCE_DISCOUNT : 1));
    const rule = near.length ? '두 나라가 들어간 근거 있는 쌍의 중앙값' : pool.length ? '근거 있는 전체 쌍의 중앙값' : '기본값';
    return { ...r, tension, confidence: TENSION_ESTIMATE.CONFIDENCE, components: { ...r.components, ...(alliance ? { alliance: { ...alliance, before: r1(baseline) } } : {}), estimated: { rule, baseline: r1(baseline), pairs: pool.length } } };
  });
}
