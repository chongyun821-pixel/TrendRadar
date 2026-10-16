import type { Category, Forecast, ProgramRecord, Seed, BatchCalc, Source, SystemKey } from './types';
import { seed as defaultSeed } from './data';

export const BASE_YEAR = new Date().getFullYear();
export const DEFAULT_RATIO: [number, number] = [0.6, 1.0];
/** 사업 규모(억 원) 로그 스케일 범위: 100억 ~ 50만억 */
export const SIZE_LOG_MIN = 2, SIZE_LOG_MAX = 5.7;

/** 교체 시점 = 도입 연도 + 설계 수명 + MRO로 늘어난 수명 */
export const replacementYear = (introYear: number, designLife: number, lifeExt = 0) => introYear + designLife + lifeExt;

/** 임박도 색: 남은 기간(년) 기준 */
export function categoryOf(remaining: number | null): Category {
  if (remaining == null) return 'gray';
  if (remaining <= 2) return 'red';
  if (remaining <= 5) return 'orange';
  if (remaining <= 10) return 'yellow';
  return 'blue';
}

/** 임박도 점수 0~100: 남은 기간이 짧을수록, 노후 비율·최근 신호가 많을수록 높다 */
export function imminenceScore(remaining: number, agedShare = 0, signals = 0): number {
  const s = 100 * Math.exp(-Math.max(0, remaining) / 7) + 10 * agedShare + Math.min(15, 5 * signals);
  return Math.round(Math.max(0, Math.min(100, s)));
}

export function sizeNorm(krw: [number, number]): number {
  const mid = Math.sqrt(Math.max(1, krw[0]) * Math.max(1, krw[1]));
  if (krw[1] <= 0) return 0;
  return Math.max(0, Math.min(1, (Math.log10(mid) - SIZE_LOG_MIN) / (SIZE_LOG_MAX - SIZE_LOG_MIN)));
}

/** 신뢰도: 근거 수, 최신성, 추정값 개수 */
export function confidenceOf(nSources: number, latestYear: number, estCount: number, base = new Date().getFullYear()): '상' | '중' | '하' {
  let p = Math.min(nSources, 4);
  p += latestYear >= base - 1 ? 2 : latestYear >= base - 4 ? 1 : 0;
  p -= Math.floor(estCount / 3); // estCount: 레코드 고유 추정 항목 수
  return p >= 5 ? '상' : p >= 3 ? '중' : '하';
}

const r10 = (n: number) => Math.round(n);

export function computeForecast(rec: ProgramRecord, seed: Seed = defaultSeed, base = new Date().getFullYear()): Forecast {
  const sys = seed.systems[rec.system];
  const c = seed.countries[rec.country];
  const life = sys.designLife;
  const ratio = rec.ratio ?? DEFAULT_RATIO;
  const ratioEst = rec.ratio ? !!rec.ratioEst : true;
  const calc: string[] = [];
  let estCount = 0; // 레코드 고유 추정 항목 수 (설계 수명·교체 비율 기본값은 별도)
  const baseEst = 1 + (ratioEst ? 1 : 0) + (sys.unitCostEst ? 1 : 0);

  const batches: BatchCalc[] = rec.batches.map(b => {
    const ext = b.lifeExt ?? 0;
    estCount += (b.est?.length ?? 0);
    return { model: b.model, introYear: b.introYear, qty: b.qty, life, ext, year: replacementYear(b.introYear, life, ext), est: b.est ?? [] };
  });
  const covers = rec.awarded?.covers ?? 0;
  const openAll = rec.batches.map((b, i) => ({ b, c: batches[i] })).filter(x => !x.b.covered);
  // 다음 사업 = 가장 이른 교체 시점에서 8년 안에 몰린 배치들 (그 뒤 배치는 다음 주기)
  const first = Math.min(...openAll.map(x => x.c.year));
  const open = openAll.filter(x => x.c.year <= first + 8);
  const openQty = open.reduce((s, x) => s + x.b.qty, 0) * Math.max(0, 1 - covers);
  if (rec.awarded) estCount += rec.awarded.est?.length ?? 0;
  if (rec.plan) estCount += rec.plan.est?.length ?? 0;
  for (const m of rec.mro ?? []) estCount += m.est?.length ?? 0;

  for (const x of batches) calc.push(`${x.model}: ${x.introYear} + 수명 ${x.life}${x.ext ? ` + MRO ${x.ext}` : ''} = ${x.year}년`);

  let status: Forecast['status'] = 'none';
  let window: [number, number] | null = null;
  let qty: [number, number] = [0, 0];
  let qtyEst = ratioEst;
  let agedShare = 0;

  if (rec.plan) {
    status = 'plan';
    window = [Math.max(base, rec.plan.start), Math.max(base, rec.plan.end)];
    qty = [rec.plan.qty[0], rec.plan.qty[1]];
    qtyEst = !!rec.plan.est?.includes('qty');
    calc.push(`공개 계획: ${rec.plan.text} → ${window[0]}~${window[1]}년, ${qty[0]}~${qty[1]}${sys.unit}`);
  } else if (open.length && openQty > 0) {
    status = 'open';
    const years = open.map(x => x.c.year);
    const lo = Math.min(...years) - 2, hi = Math.max(...years) + 3;
    const start = Math.max(base, lo);
    window = [start, Math.max(start + 1, hi)];
    qty = [Math.max(1, r10(openQty * ratio[0])), Math.max(1, r10(openQty * ratio[1]))];
    const aged = open.filter(x => x.c.year <= base + 2).reduce((s, x) => s + x.b.qty, 0);
    agedShare = aged / Math.max(1, open.reduce((s, x) => s + x.b.qty, 0));
    calc.push(`교체 창: 배치별 교체 시점 −2~+3년 → ${window[0]}~${window[1]}년${lo < base ? ' (일부 이미 경과)' : ''}`);
    calc.push(`예상 수량 = 미교체 보유 ${r10(openQty)}${sys.unit}${covers > 0 ? ` (계약분 ${Math.round(covers * 100)}% 제외)` : ''} × 교체 비율 ${ratio[0]}~${ratio[1]}`);
  } else if (rec.awarded && rec.awarded.qty > 0) {
    status = 'next';
    const y = replacementYear(rec.awarded.deliveryEnd, life);
    window = [Math.max(base, y - 3), Math.max(base + 1, y + 3)];
    qty = [Math.max(1, r10(rec.awarded.qty * ratio[0])), Math.max(1, r10(rec.awarded.qty * ratio[1]))];
    calc.push(`현 사업 계약 완료 → 후속 주기: 인도 완료 ${rec.awarded.deliveryEnd} + 수명 ${life} = ${y}년`);
    calc.push(`후속 수량 = 계약 ${rec.awarded.qty}${sys.unit} × 교체 비율 ${ratio[0]}~${ratio[1]}`);
  }

  const krw: [number, number] = [r10(qty[0] * sys.unitCost[0]), r10(qty[1] * sys.unitCost[1])];
  if (status !== 'none') calc.push(`예상 금액 = 수량 × 대당 ${sys.unitCost[0].toLocaleString()}~${sys.unitCost[1].toLocaleString()}억 원 (${sys.unitCostBasis})`);

  const signals = (rec.signals ?? []).filter(s => s.year >= base - 1).length;
  let remaining = window ? window[0] - base : null;
  const category = categoryOf(remaining);
  const score = remaining == null ? 0 : imminenceScore(remaining, agedShare, signals);

  // 근거 모으기
  const ids = new Set<string>(rec.src);
  rec.batches.forEach(b => b.src.forEach(s => ids.add(s)));
  rec.awarded?.src.forEach(s => ids.add(s));
  rec.plan?.src.forEach(s => ids.add(s));
  rec.mro?.forEach(m => m.src.forEach(s => ids.add(s)));
  rec.signals?.forEach(m => m.src.forEach(s => ids.add(s)));
  rec.projects?.forEach(p => p.src.forEach(s => ids.add(s)));
  const byUrl = new Map<string, Source>();
  const sourceTime = (s: Source) => Date.parse(s.collectedAt || '') || s.y;
  for (const s of [...ids].map(id => seed.sources[id]).filter(Boolean)) {
    const key = s.u.replace(/#.*$/, '').replace(/\/$/, '');
    const previous = byUrl.get(key);
    if (!previous || sourceTime(s) >= sourceTime(previous)) byUrl.set(key, s);
  }
  const contentHashes = new Set<string>();
  const sources: Source[] = [...byUrl.values()].filter(s => {
    if (s.hash && contentHashes.has(s.hash)) return false;
    if (s.hash) contentHashes.add(s.hash); return true;
  });
  const latest = Math.max(0, ...sources.map(s => s.y));
  const uncertainty = (rec.analysis?.conflicts.length || 0) + (rec.analysis?.unknowns.length || 0);
  const confidence = confidenceOf(sources.length, latest, estCount + baseEst + uncertainty * 3, base);
  estCount += baseEst;

  const openCalc = open.map(x => x.c).sort((a, b) => b.qty - a.qty);
  const current = openCalc[0] ?? batches[0] ?? null;

  return {
    id: rec.id, country: rec.country, countryKo: c?.ko ?? rec.country, flag: c?.flag ?? '', system: rec.system, systemKo: sys.ko, unit: sys.unit,
    status, window, remaining, category, score, qty, krw, size: status === 'none' ? 0 : sizeNorm(krw),
    confidence, nSources: sources.length, latestSource: latest, estCount,
    current, batches, calc, sources, qtyEst, krwEst: qtyEst || sys.unitCostEst, lifeEst: true,
  };
}

export function allForecasts(system?: SystemKey | null, seed: Seed = defaultSeed): Forecast[] {
  return seed.records.filter(r => !system || r.system === system).map(r => computeForecast(r, seed));
}

export const CATEGORY_KO: Record<Category, string> = { red: '2년 이내', orange: '3~5년', yellow: '6~10년', blue: '10년 이후', gray: '데이터 부족' };
export const fmtKrw = (n: number) => n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}조` : `${n.toLocaleString()}억`;
export const fmtKrwRange = (k: [number, number]) => `${fmtKrw(k[0])}~${fmtKrw(k[1])} 원`;
