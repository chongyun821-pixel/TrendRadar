import type { Category, Forecast, ProgramRecord, Project, ProjectStage, ProgramView, Seed, SystemMeta, Batch, BatchCalc, Source, SystemKey, ScoreBreakdown, ScoreComponent, ScoreFactor, SignalRow, InventoryRow, BudgetRow, NeighborRow, ConsumptionRow, CapacityRow, DomesticRow, SystemLinkRow, ExportTierRow, SignalStage, TierReason } from './types';
import { seed as defaultSeed } from './data';
import { isRecent, recentRange } from './base-year';
import { cleanTierReason } from './tiers';
import { countryName } from './country-name';
import { koreanizeHanwha } from './hanwha';

export const DEFAULT_RATIO: [number, number] = [0.6, 1.0];
/** 사업 규모(억 원) 로그 스케일 범위: 100억 ~ 50만억 */
export const SIZE_LOG_MIN = 2, SIZE_LOG_MAX = 5.7;

/** 교체 시점 = 도입 연도 + 설계 수명 + MRO로 늘어난 수명 */
export const replacementYear = (introYear: number, designLife: number, lifeExt = 0) => introYear + designLife + lifeExt;

/** 남은 기간(년)별 임박도 구간. 기존 API의 색 이름 ID는 유지하며 지도 색상은 무기체계로 정한다. */
export function categoryOf(remaining: number | null): Category {
  if (remaining == null) return 'gray';
  if (remaining <= 2) return 'red';
  if (remaining <= 5) return 'orange';
  if (remaining <= 10) return 'yellow';
  return 'blue';
}

/** 임박도 점수 0~100: 남은 기간이 짧을수록, 노후 비율, 최근 신호가 많을수록 높다 */
export function imminenceScore(remaining: number, agedShare = 0, signals = 0): number {
  const s = 100 * Math.exp(-Math.max(0, remaining) / 7) + 10 * agedShare + Math.min(15, 5 * signals);
  return Math.round(Math.max(0, Math.min(100, s)));
}

export function sizeNorm(krw: [number, number] | null): number {
  if (!krw) return 0;
  const mid = Math.sqrt(Math.max(1, krw[0]) * Math.max(1, krw[1]));
  if (krw[1] <= 0) return 0;
  return Math.max(0, Math.min(1, (Math.log10(mid) - SIZE_LOG_MIN) / (SIZE_LOG_MAX - SIZE_LOG_MIN)));
}

/** 신뢰도: 근거 수, 최신성(기준 연도 대비), 추정값 개수 */
export function confidenceOf(nSources: number, latestYear: number, estCount: number, base: number): '상' | '중' | '하' {
  let p = Math.min(nSources, 4);
  p += latestYear >= base - 1 ? 2 : latestYear >= base - 4 ? 1 : 0;
  p -= Math.floor(estCount / 3); // estCount: 레코드 고유 추정 항목 수
  return p >= 5 ? '상' : p >= 3 ? '중' : '하';
}

const r10 = (n: number) => Math.round(n);
/** 현재 운용 배치(퇴역, 도입 예정, 0대 제외). 기준 연도 기본값은 meta.baseYear */
export const isCurrentBatch = (b: Pick<Batch, 'status' | 'qty' | 'introYear'>, base = defaultSeed.meta.baseYear) => b.status !== 'retired' && b.status !== 'planned' && b.status !== 'stored' && b.qty !== 0 && (b.introYear == null || b.introYear <= base);

/** 설계 수명에 실제 출처(systems.lifeSrc)가 하국가도 있으면 추정이 아니다 */
export const lifeSourced = (sys: SystemMeta, data: Seed) => !!sys.lifeSrc?.some(id => data.sources[id]);

/* ───────── 진행 중 사업(projects) ───────── */

export const PROJECT_STAGE_KO: Record<ProjectStage, string> = { consideration: '검토', plan: '계획', tender: '입찰 또는 선정 중', selected: '공급자 선정(계약 전)', contract: '계약 체결', delivery: '인도 중', completed: '완료', cancelled: '취소' };
/** 공급자가 정해진 단계. 이 단계 사업은 기존 전력 교체 수요를 채우며(covers, 기본 1) 사업 기회가 아니다 */
export const COMMITTED_STAGES: readonly ProjectStage[] = ['selected', 'contract', 'delivery', 'completed'];
/** 선정 전 경쟁 단계. 사업 기회로 남는다 */
export const OPEN_STAGES: readonly ProjectStage[] = ['consideration', 'plan', 'tender'];
const projectYear = (p: Project) => p.contractYear ?? p.decisionYear ?? p.deliveryStart ?? p.deliveryEnd ?? 0;
const hasProjectYear = (p: Project) => Number.isInteger(projectYear(p)) && projectYear(p) >= 1800 && projectYear(p) <= 2300;
const coverOf = (p: Project) => Math.max(0, Math.min(1, p.covers ?? 1));

/**
 * 기록의 사업 현황. 공급자가 정해진 사업(COMMITTED_STAGES) 중 가장 최근 것을 대표로 하고 그 사업들의 covers 합(최대 1)을 교체 충족 비율로 본다.
 * 그런 사업이 없으면 선정 전 사업(open: true), 그것도 없으면 기존 awarded(계약 완료)를 같은 모양으로 돌려준다.
 */
export function programOf(rec: ProgramRecord, unit = '', base = defaultSeed.meta.baseYear): ProgramView | null {
  const live = (rec.projects ?? []).filter(p => p.stage !== 'cancelled');
  const byRecent = (a: Project, b: Project) => projectYear(b) - projectYear(a);
  const committed = live.filter(p => COMMITTED_STAGES.includes(p.stage) && hasProjectYear(p)).sort(byRecent);
  const p = committed[0] ?? live.filter(p => OPEN_STAGES.includes(p.stage)).sort(byRecent)[0];
  if (p) {
    const open = !COMMITTED_STAGES.includes(p.stage);
    const v: ProgramView = {
      id: p.id, stage: p.stage, stageKo: PROJECT_STAGE_KO[p.stage], supplier: p.supplier ? (/^[A-Z]{3}$/.test(p.supplier) ? countryName(p.supplier) : koreanizeHanwha(p.supplier)) : null, model: p.model ?? null, reserve: p.reserve ? (/^[A-Z]{3}$/.test(p.reserve) ? countryName(p.reserve) : koreanizeHanwha(p.reserve)) : null,
      qty: p.qty ?? null, amount: p.amount ?? null, currency: p.currency ?? null,
      decisionYear: p.decisionYear ?? null, contractYear: p.contractYear ?? null, deliveryStart: p.deliveryStart ?? null, deliveryEnd: p.deliveryEnd ?? null,
      covers: open ? 0 : Math.min(1, committed.reduce((s, x) => s + coverOf(x), 0)), open, reason: '', text: p.text, est: p.est ?? [], src: p.src,
    };
    v.reason = programReason(v, unit, base);
    return v;
  }
  if (!rec.awarded) return null;
  const a = rec.awarded;
  const v: ProgramView = {
    id: 'awarded', stage: a.deliveryEnd < base ? 'completed' : 'contract', stageKo: '', supplier: null, model: null, reserve: null,
    qty: a.qty, amount: null, currency: null, decisionYear: a.year, contractYear: a.year, deliveryStart: null, deliveryEnd: a.deliveryEnd,
    covers: Math.max(0, Math.min(1, a.covers)), open: false, reason: '', text: a.text, est: (a.est ?? []).map(f => f === 'year' ? 'contractYear' : f), src: a.src,
  };
  v.stageKo = PROJECT_STAGE_KO[v.stage];
  v.reason = programReason(v, unit, base);
  return v;
}

/** 근거 문구. 예: "진행 중 사업(계약 체결): Lockheed Martin M142 HIMARS 26대, 2026 계약, 2029~2034 인도 예정" */
export function programReason(p: ProgramView, unit = '', base = defaultSeed.meta.baseYear) {
  const e = (f: string) => (p.est.includes(f) ? ' (추정)' : '');
  const supplier = p.supplier ? (/^[A-Z]{3}$/.test(p.supplier) ? countryName(p.supplier) : koreanizeHanwha(p.supplier)) : p.supplier;
  const reserve = p.reserve ? (/^[A-Z]{3}$/.test(p.reserve) ? countryName(p.reserve) : koreanizeHanwha(p.reserve)) : p.reserve;
  const head = [supplier, p.model, p.qty != null ? `${p.qty.toLocaleString()}${unit}${e('qty')}` : null].filter(Boolean).join(' ');
  const parts: string[] = head ? [head] : [];
  if (p.stage === 'selected') {
    if (p.decisionYear != null) parts.push(`${p.decisionYear} 공급자 선정${e('decisionYear')}`);
    if (p.contractYear != null) parts.push(`${p.contractYear}년까지 계약 예정${e('contractYear')}`);
  } else if (p.contractYear != null) parts.push(`${p.contractYear} ${p.open ? '계약 목표' : '계약'}${e('contractYear')}`);
  const ds = p.deliveryStart, de = p.deliveryEnd, future = (y: number) => (y >= base ? ' 예정' : '');
  if (ds != null && de != null) parts.push(`${ds}${e('deliveryStart')}~${de}${e('deliveryEnd')} 인도${future(de)}`);
  else if (ds != null) parts.push(`${ds}년 인도 시작${future(ds)}${e('deliveryStart')}`);
  else if (de != null) parts.push(`${de}년 인도 완료${future(de)}${e('deliveryEnd')}`);
  if (reserve) parts.push(`예비 공급자 ${reserve}`);
  if (!parts.length) parts.push(p.text);
  return `${p.open ? '선정 전 경쟁' : '진행 중 사업'}(${p.stageKo}), ${parts.join(', ')}`;
}

/** 공급자가 정해진 사업이 기존 전력 교체 수요를 모두 채워 다음 교체 시점이 '후속 주기'인 경우 */
export const needMet = (f?: Forecast | null): f is Forecast & { program: ProgramView } => !!f && f.status === 'next' && !!f.program && !f.program.open && f.program.covers >= 1;

/** 기준 연도는 data.meta.baseYear(shared/base-year.ts). base 인자는 같은 값을 명시할 때만 쓴다 */
export function computeForecast(rec: ProgramRecord, seed: Seed = defaultSeed, base = seed.meta.baseYear): Forecast {
  const sys = seed.systems[rec.system];
  const c = seed.countries[rec.country];
  const life = sys.designLife;
  const ratio = rec.ratio ?? DEFAULT_RATIO;
  const ratioEst = rec.ratio ? !!rec.ratioEst : true;
  const calc: string[] = [];
  let estCount = 0; // 레코드 고유 추정 항목 수 (설계 수명, 교체 비율 기본값은 별도)
  const lifeEst = !lifeSourced(sys, seed);
  const baseEst = (lifeEst ? 1 : 0) + (ratioEst ? 1 : 0) + (sys.unitCostEst ? 1 : 0);

  const batches: BatchCalc[] = rec.batches.map(b => {
    const ext = b.lifeExt ?? 0;
    estCount += (b.est?.length ?? 0) + (b.qty == null ? 3 : 0) + (b.introYear == null ? 3 : 0);
    return { model: b.model, introYear: b.introYear, qty: b.qty, life, ext, year: b.introYear == null ? null : replacementYear(b.introYear, life, ext), primary: b.primary, status: b.status, est: b.est ?? [] };
  });
  const program = programOf(rec, sys.unit, base);
  // 공급자가 정해진 사업이라도 계약, 선정, 인도 연도가 하나도 없으면 후속 주기를 셀 수 없으므로 교체 계산에 쓰지 않는다(설명만 있는 사업)
  const hasYear = (p: ProgramView) => [p.deliveryStart, p.deliveryEnd, p.contractYear, p.decisionYear].some(y => y != null);
  const committed = program && !program.open && program.id !== 'awarded' && hasYear(program) ? program : null;
  if (committed) estCount += committed.est.length;
  const covers = Math.max(rec.awarded?.covers ?? 0, committed?.covers ?? 0);
  const active = rec.batches.map((b, i) => ({ b, c: batches[i] })).filter(x => isCurrentBatch(x.b, base));
  const openAll = active.filter(x => !x.b.covered);
  const dated = openAll.filter((x): x is typeof x & { c: BatchCalc & { year: number } } => x.c.year != null);
  // 다음 사업 = 가장 이른 교체 시점에서 8년 안에 몰린 배치들 (그 뒤 배치는 다음 주기)
  const first = Math.min(...dated.map(x => x.c.year));
  const open = dated.filter(x => x.c.year <= first + 8);
  const quantityKnown = open.every(x => x.b.qty != null) && openAll.every(x => x.c.year != null);
  const openQty = open.reduce((s, x) => s + (x.b.qty ?? 0), 0) * Math.max(0, 1 - covers);
  if (rec.awarded) estCount += rec.awarded.est?.length ?? 0;
  if (rec.plan) estCount += rec.plan.est?.length ?? 0;
  for (const m of rec.mro ?? []) estCount += m.est?.length ?? 0;

  for (const { c: x } of active) calc.push(x.year == null ? `${x.model}: 도입 연도 미확인으로 교체 시기 산출 불가` : `${x.model}: ${x.introYear} + 수명 ${x.life}${x.ext ? ` + MRO ${x.ext}` : ''} = ${x.year}년`);

  let status: Forecast['status'] = 'none';
  let window: [number, number] | null = null;
  let qty: [number, number] | null = null;
  let qtyEst = ratioEst;
  let agedShare = 0;

  /** 진행 사업 인도 연도 + 설계 수명 = 후속 주기. 인도 연도가 없으면 계약(선정) 연도 + 수명 ±3년 */
  const nextFromProgram = (p: ProgramView) => {
    status = 'next';
    const ds = p.deliveryStart, de = p.deliveryEnd, anchor = p.contractYear ?? p.decisionYear;
    let range: [number, number] | null = null, basis = '';
    if (ds != null && de != null) { range = [ds + life, de + life]; basis = `인도 ${ds}~${de} + 수명 ${life}`; }
    else if (ds != null || de != null) { const y = (ds ?? de)! + life; range = [y - 3, y + 3]; basis = `인도 ${ds != null ? `시작 ${ds}` : `완료 ${de}`} + 수명 ${life} = ${y}년 ±3`; }
    else if (anchor != null) { const y = anchor + life; range = [y - 3, y + 3]; basis = `인도 연도 미공개, 계약 또는 선정 ${anchor} + 수명 ${life} = ${y}년 ±3`; }
    calc.push(`${p.reason} → 기존 전력 교체 수요 충족${p.covers < 1 ? ` (${Math.round(p.covers * 100)}%)` : ''}`);
    if (range) {
      const start = Math.max(base, range[0]);
      window = [start, Math.max(start + 1, range[1])];
      calc.push(`다음 교체 주기(추정) = ${basis} → ${window[0]}~${window[1]}년`);
    } else calc.push('인도 연도와 계약 연도 미확인으로 후속 주기 산출 불가');
    if (p.qty != null) { qty = [Math.max(1, r10(p.qty * ratio[0])), Math.max(1, r10(p.qty * ratio[1]))]; qtyEst = ratioEst || p.est.includes('qty'); calc.push(`후속 수량 = 사업 ${p.qty}${sys.unit} × 교체 비율 ${ratio[0]}~${ratio[1]}`); }
    if (rec.plan) calc.push(`공개 계획(${rec.plan.text})은 진행 사업으로 대체되어 교체 창 계산에 쓰지 않음`);
  };

  if (committed && committed.covers >= 1) nextFromProgram(committed);
  else if (rec.plan) {
    status = 'plan';
    window = [Math.max(base, rec.plan.start), Math.max(base, rec.plan.end)];
    qty = rec.plan.qty ? [rec.plan.qty[0], rec.plan.qty[1]] : null;
    qtyEst = !!rec.plan.est?.includes('qty');
    calc.push(`공개 계획: ${rec.plan.text} → ${window[0]}~${window[1]}년, ${qty ? `${qty[0]}~${qty[1]}${sys.unit}` : '수량 미확인'}`);
  } else if (open.length && covers < 1 && (openQty > 0 || !quantityKnown)) {
    status = 'open';
    const years = open.map(x => x.c.year);
    const lo = Math.min(...years) - 2, hi = Math.max(...years) + 3;
    const start = Math.max(base, lo);
    window = [start, Math.max(start + 1, hi)];
    if (quantityKnown) qty = [Math.max(1, r10(openQty * ratio[0])), Math.max(1, r10(openQty * ratio[1]))];
    const aged = open.filter(x => x.c.year <= base + 2).reduce((s, x) => s + (x.b.qty ?? 0), 0);
    agedShare = quantityKnown ? aged / Math.max(1, open.reduce((s, x) => s + (x.b.qty ?? 0), 0)) : 0;
    calc.push(`교체 창: 배치별 교체 시점 −2~+3년 → ${window[0]}~${window[1]}년${lo < base ? ' (일부 이미 경과)' : ''}`);
    if (qty) calc.push(`예상 수량 = 미교체 보유 ${r10(openQty)}${sys.unit}${covers > 0 ? ` (계약분 ${Math.round(covers * 100)}% 제외)` : ''} × 교체 비율 ${ratio[0]}~${ratio[1]}`);
    else calc.push('확인된 도입 연도와 체계 기본 수명으로 시기만 추정. 수량 미확인 배치를 0으로 합산하지 않으며 사업 수량과 금액은 산출하지 않음');
  } else if (committed) nextFromProgram(committed);
  else if (rec.awarded && (rec.awarded.qty == null || rec.awarded.qty > 0)) {
    status = 'next';
    const y = replacementYear(rec.awarded.deliveryEnd, life);
    window = [Math.max(base, y - 3), Math.max(base + 1, y + 3)];
    if (rec.awarded.qty != null) qty = [Math.max(1, r10(rec.awarded.qty * ratio[0])), Math.max(1, r10(rec.awarded.qty * ratio[1]))];
    calc.push(`현 사업 계약 완료 → 후속 주기: 인도 완료 ${rec.awarded.deliveryEnd} + 수명 ${life} = ${y}년`);
    if (qty) calc.push(`후속 수량 = 계약 ${rec.awarded.qty}${sys.unit} × 교체 비율 ${ratio[0]}~${ratio[1]}`);
  }

  if (program && !program.open && program.id !== 'awarded' && !committed) calc.push(`${program.reason} → 계약 연도와 인도 연도 미확인으로 교체 계산에 반영하지 않음`);
  if (program?.open) calc.push(`${program.reason} → 공급자 미정, 사업 기회 유지`);

  const krw: [number, number] | null = qty ? [r10(qty[0] * sys.unitCost[0]), r10(qty[1] * sys.unitCost[1])] : null;
  if (krw) calc.push(`예상 금액 = 수량 × 대당 ${sys.unitCost[0].toLocaleString()}~${sys.unitCost[1].toLocaleString()}억 원 (${sys.unitCostBasis})`);

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

  const current = active.map(x => x.c).sort((a, b) => Number(!!b.primary) - Number(!!a.primary) || (b.qty ?? -1) - (a.qty ?? -1) || (b.introYear ?? 0) - (a.introYear ?? 0))[0] ?? null;

  return {
    id: rec.id, country: rec.country, countryKo: countryName(rec.country, seed), flag: c?.flag ?? '', system: rec.system, systemKo: sys.ko, unit: sys.unit,
    status, window, remaining, category, score, qty, krw, size: status === 'none' ? 0 : sizeNorm(krw),
    confidence, nSources: sources.length, latestSource: latest, estCount,
    current, batches, calc, sources, qtyEst, krwEst: qtyEst || sys.unitCostEst, lifeEst, program,
  };
}

export function allForecasts(system?: SystemKey | null, seed: Seed = defaultSeed): Forecast[] {
  return seed.records.filter(r => !system || r.system === system).map(r => computeForecast(r, seed));
}

export const CATEGORY_KO: Record<Category, string> = { red: '2년 이내', orange: '3~5년', yellow: '6~10년', blue: '10년 이후', gray: '데이터 부족' };
/** 억원 단위 금액을 화면과 보고서에서 공통으로 표기한다. */
export function formatKrw(amountInEok: number): string {
  if (amountInEok === 0) return '0억';
  const sign = amountInEok < 0 ? '-' : '';
  const amount = Math.abs(amountInEok);
  if (amount >= 10000) {
    const trillion = Math.round(amount / 1000) / 10;
    return `${sign}${Number.isInteger(trillion) ? trillion : trillion.toFixed(1)}조`;
  }
  if (amount >= 100) {
    const eok = Math.round(amount);
    if (eok >= 10000) return `${sign}1조`;
    return `${sign}${eok.toLocaleString('en-US')}억`;
  }
  const eok = Math.round(amount * 10) / 10;
  return `${sign}${Number.isInteger(eok) ? eok : eok.toFixed(1)}억`;
}
export const fmtKrw = formatKrw;
export const fmtKrwRange = (k: [number, number] | null) => k ? `${formatKrw(k[0])}~${formatKrw(k[1])} 원` : '금액 미확인';
export const fmtQtyRange = (q: [number, number] | null, unit: string) => q ? `${q[0].toLocaleString()}~${q[1].toLocaleString()}${unit}` : '수량 미확인';

/* ───────── 수출 종합 점수 (요구서 6장) ───────── */

/** weights 테이블이 비었거나 일부만 있을 때 쓰는 요구서 기본값. tier, domestic 계수도 같은 표에서 조정한다. */
export const DEFAULT_WEIGHTS: Record<string, number> = { intent: 20, aging: 20, fiscal: 15, neighbor: 15, consumption: 10, competition: 15, access: 5, tier1: 1, tier2: 0.7, domestic_development: 0.8 };
export const SCORE_FACTORS: { factor: ScoreFactor; label: string }[] = [
  { factor: 'intent', label: '도입 의사 표명' }, { factor: 'aging', label: '노후화' }, { factor: 'fiscal', label: '재정 여력' }, { factor: 'neighbor', label: '주변국 압력' },
  { factor: 'consumption', label: '소모 보충' }, { factor: 'competition', label: '경쟁 우위' }, { factor: 'access', label: '접근성' },
];
/** 도입 의사 단계 점수(20점 만점): 검토 5, 입찰 15, 선정 대기 20. 계약, 인도, 취소는 열린 수요가 아니다. */
export const STAGE_POINTS: Record<SignalStage, number> = { consideration: 5, tender: 15, selected: 20, contract: 0, delivery: 0, cancelled: 0 };
/** 출처 신뢰도: 공식 발표, DB 1.0, 전문 매체 0.7, 일반 뉴스, X 0.4. 값이 없으면 가장 낮은 값으로 본다. */
export const SOURCE_CONFIDENCE = { official: 1, specialist: 0.7, news: 0.4 } as const;
const FORECAST_CONFIDENCE = { 상: 1, 중: 0.7, 하: 0.4 } as const;

export interface ScoreInputs {
  country: string; system: SystemKey; weights?: Record<string, number>;
  tier?: ExportTierRow | null; domestic?: DomesticRow | null;
  signals?: SignalRow[]; inventory?: InventoryRow[]; budgets?: BudgetRow[];
  neighbors?: NeighborRow[]; neighborSignals?: SignalRow[]; neighborBudgets?: BudgetRow[];
  consumption?: ConsumptionRow[]; capacity?: CapacityRow[]; links?: SystemLinkRow[];
  /** 같은 체계의 전체 국가 신호(그룹사, 경쟁사 수주 실적 비교용) */
  systemSignals?: SignalRow[];
  /** 기존 기록 예측. 보유 이력 테이블이 비었을 때 노후화 판단에 쓴다 */
  forecast?: Forecast | null; designLife?: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
const round1 = (n: number) => Math.round(n * 10) / 10;
const confOf = (rows: { confidence?: number | null }[]) => rows.length ? rows.reduce((s, r) => s + (r.confidence ?? SOURCE_CONFIDENCE.news), 0) / rows.length : 0;
const yearOf = (s: { published_at?: string | null; expected_year?: number | null }) => Number(String(s.published_at || '').slice(0, 4)) || s.expected_year || 0;
const sameModel = (a?: string | null, b?: string | null) => !!a && !!b && (a.toLowerCase().includes(b.toLowerCase()) || b.toLowerCase().includes(a.toLowerCase()));
export const evidenceId = {
  signal: (r: SignalRow) => `signals:${r.id}`, inventory: (r: InventoryRow) => `inventory:${r.id}`, budget: (r: BudgetRow) => `budgets:${r.country}:${r.year}`,
  neighbor: (r: NeighborRow) => `neighbors:${r.country}:${r.neighbor}`, consumption: (r: ConsumptionRow) => `consumption:${r.id}`,
  capacity: (r: CapacityRow) => `supplier_capacity:${r.maker}:${r.model}:${r.year}`, tier: (r: ExportTierRow) => `export_tiers:${r.country}:${r.system}`,
  domestic: (r: DomesticRow) => `domestic_capability:${r.country}:${r.system}`,
};

/** 국방비 최근 3개 연도 전년 대비 증가율(%) 평균. yoy_pct가 없으면 usd_m 연속 연도로 계산하고, base를 주면 '최근 3년'(base-3..base, 기준 연도 포함 4개년) 값만 쓴다(오래된 급증이 남지 않게) */
export function growth3y(budgets: BudgetRow[], base?: number): { value: number | null; rows: BudgetRow[] } {
  const sorted = [...budgets].sort((a, b) => a.year - b.year);
  const yoy = sorted.map((b, i) => {
    if (b.yoy_pct != null) return { row: b, v: b.yoy_pct };
    const prev = sorted[i - 1];
    return prev && prev.year === b.year - 1 && prev.usd_m && b.usd_m != null ? { row: b, v: (b.usd_m / prev.usd_m - 1) * 100 } : null;
  }).filter((x): x is { row: BudgetRow; v: number } => !!x && (base == null || isRecent(x.row.year, base))).slice(-3);
  return yoy.length ? { value: yoy.reduce((s, x) => s + x.v, 0) / yoy.length, rows: yoy.map(x => x.row) } : { value: null, rows: [] };
}

/**
 * 인도 연도(delivered_year)가 없는 보유 행의 추정 규칙(노후화). retire_year가 있으면 그 값을 쓰고 추정하지 않는다.
 * 1) 같은 모델 기존 기록 배치의 도입 연도 2) 같은 모델 계약, 인도 신호의 가장 이른 연도(사업 연도)
 * 3) 둘 다 없으면 기준 연도 − 설계 수명의 절반(수명 중간에 있는 전력으로 가정).
 * 추정 행의 신뢰도는 원래 신뢰도에 근거 있는 추정(1, 2) 0.7, 기본값(3) 0.4를 곱한다.
 */
export const INVENTORY_ESTIMATE = { derived: 0.7, default: 0.4 } as const;
export type DeliveryBasis = 'batch' | 'signal' | 'default';
const BASIS_KO: Record<DeliveryBasis, string> = { batch: '배치 도입 연도', signal: '계약 또는 인도 신호', default: '기본값(수명 중간)' };
export function estimateDelivered(i: InventoryRow, base: number, life: number, batches: BatchCalc[] = [], signals: SignalRow[] = []): { year: number; basis: DeliveryBasis } {
  const batch = batches.filter((b): b is BatchCalc & { introYear: number } => b.introYear != null && sameModel(b.model, i.model)).sort((a, b) => a.introYear - b.introYear)[0];
  if (batch) return { year: batch.introYear, basis: 'batch' };
  const years = signals.filter(s => s.system === i.system && ['contract', 'delivery'].includes(s.stage) && sameModel(s.model, i.model)).map(yearOf).filter(y => y > 0);
  if (years.length) return { year: Math.min(...years), basis: 'signal' };
  return { year: base - Math.round(life / 2), basis: 'default' };
}

/** 기준 연도 base는 data.meta.baseYear를 넘긴다(server/scoring.ts) */
export function computeScore(input: ScoreInputs, base: number): ScoreBreakdown {
  const w = { ...DEFAULT_WEIGHTS, ...(input.weights || {}) };
  const comps: ScoreComponent[] = [];
  const add = (factor: ScoreFactor, raw: number, confidence: number, evidence: string[], detail: string, missing = false, estimated = false) => {
    const weight = w[factor] ?? 0, r = missing ? 0 : clamp01(raw), c = missing ? 0 : clamp01(confidence);
    comps.push({ factor, label: SCORE_FACTORS.find(f => f.factor === factor)!.label, weight, raw: round1(r * 100) / 100, confidence: round1(c * 100) / 100, points: round1(weight * r * c), missing, detail, evidence, ...(estimated ? { estimated } : {}) });
  };
  const signals = (input.signals || []).filter(s => s.system === input.system);
  const imminence: number[] = [];

  // 진행 중 사업: 공급자가 정해져 교체 수요를 채웠으면 그 사업의 신호, 기존 전력 노후화는 열린 수요가 아니다
  const met = needMet(input.forecast) ? input.forecast : null;
  const prog = met?.program ?? null;
  const decided = prog ? (prog.decisionYear ?? prog.contractYear ?? base) : null;
  /** 같은 모델이거나 공급자 결정 이전(같은 해 포함) 신호는 진행 사업이 채운 것으로 본다. 그 뒤 다른 모델 신호(전력 증강 등)는 따로 센다 */
  const satisfied = (s: SignalRow) => !!prog && (sameModel(s.model, prog.model) || yearOf(s) <= decided!);

  // 도입 의사: 현재 열린 단계 중 가장 높은 단계. '최근 3년'(기준 연도 포함 4개년) 신호이거나 예상 시기가 기준 연도 이후인 신호
  const live = signals.filter(s => STAGE_POINTS[s.stage] > 0 && (isRecent(yearOf(s), base) || (s.expected_year ?? 0) >= base));
  const open = live.filter(s => !satisfied(s)), met0 = live.filter(satisfied);
  const best = open.sort((a, b) => STAGE_POINTS[b.stage] - STAGE_POINTS[a.stage] || (b.confidence ?? 0) - (a.confidence ?? 0))[0];
  if (best) { if (best.expected_year) imminence.push(best.expected_year); add('intent', STAGE_POINTS[best.stage] / 20, best.confidence ?? SOURCE_CONFIDENCE.news, [evidenceId.signal(best)], `${best.stage} 단계 (${best.model || '모델 미상'}${best.expected_year ? `, 예상 ${best.expected_year}년` : ''})`); }
  else if (prog && met0.length) add('intent', 0, 1, [`records:${met!.id}`, ...met0.map(evidenceId.signal)], `도입 신호 ${met0.length}건은 진행 사업으로 충족: ${prog.reason}`);
  else add('intent', 0, 0, [], `최근 3년(${recentRange(base)}) 도입 의사 신호 없음`, true);

  // 노후화: 보유 이력 → 없으면 기존 기록 예측
  const life = input.designLife ?? 30;
  const inv = (input.inventory || []).filter(i => i.system === input.system && (i.quantity ?? 0) > 0);
  if (met) {
    // 기존 보유 전력은 진행 사업으로 교체되므로 다음 교체 시점은 후속 주기(인도 연도 + 수명, 추정)
    if (met.window) {
      imminence.push(met.window[0]);
      add('aging', clamp01(1 - met.remaining! / 15), FORECAST_CONFIDENCE[met.confidence], [`records:${met.id}`, ...inv.map(evidenceId.inventory)], `${prog!.reason} → 후속 주기 ${met.window[0]}~${met.window[1]}년`, false, true);
    } else add('aging', 0, FORECAST_CONFIDENCE[met.confidence], [`records:${met.id}`], `${prog!.reason}, 후속 주기 산출 불가`, false, true);
  } else if (inv.length) {
    const rows = inv.map(i => {
      const conf = i.confidence ?? SOURCE_CONFIDENCE.news;
      if (i.retire_year != null) return { i, retire: i.retire_year, confidence: conf, basis: null };
      const delivered = i.delivered_year != null ? { year: i.delivered_year, basis: null } : estimateDelivered(i, base, life, input.forecast?.batches, input.signals);
      return { i, retire: delivered.year + (i.service_life ?? life), basis: delivered.basis, confidence: delivered.basis ? conf * INVENTORY_ESTIMATE[delivered.basis === 'default' ? 'default' : 'derived'] : conf };
    });
    const first = Math.min(...rows.map(r => r.retire)), total = rows.reduce((s, r) => s + (r.i.quantity ?? 0), 0);
    const due = rows.filter(r => r.retire <= base + 10).reduce((s, r) => s + (r.i.quantity ?? 0), 0);
    const estimated = rows.filter(r => r.basis), firstEst = rows.some(r => r.basis && r.retire === first);
    const bases = (Object.keys(BASIS_KO) as DeliveryBasis[]).map(b => [b, estimated.filter(r => r.basis === b).length] as const).filter(([, n]) => n).map(([b, n]) => `${BASIS_KO[b]} ${n}`).join(', ');
    imminence.push(Math.max(base, first));
    add('aging', 0.7 * clamp01(1 - (first - base) / 15) + 0.3 * (due / Math.max(1, total)), confOf(rows), inv.map(evidenceId.inventory), `최초 퇴역 예상 ${first}년${firstEst ? ' (추정)' : ''}, 10년 내 교체 대상 ${due}/${total}${estimated.length ? `, 인도 연도 추정 ${estimated.length}건(${bases})` : ''}`, false, estimated.length > 0);
  } else if (input.forecast && input.forecast.remaining != null && input.forecast.status !== 'none') {
    const f = input.forecast;
    imminence.push(f.window![0]);
    add('aging', clamp01(1 - f.remaining! / 15), FORECAST_CONFIDENCE[f.confidence], [`records:${f.id}`], `기존 예측 교체 창 ${f.window![0]}~${f.window![1]}년 (신뢰도 ${f.confidence})`);
  } else add('aging', 0, 0, [], '보유 이력 없음', true);

  // 재정 여력
  const g = growth3y(input.budgets || [], base);
  const latest = [...(input.budgets || [])].filter(b => b.gdp_pct != null).sort((a, b) => b.year - a.year)[0];
  if (g.value != null || latest) {
    const gs = g.value != null ? clamp01(g.value / 10) : null, gdp = latest ? clamp01(latest.gdp_pct! / 3) : null;
    const raw = gs != null && gdp != null ? 0.6 * gs + 0.4 * gdp : (gs ?? gdp)!;
    const rows = [...g.rows, ...(latest ? [latest] : [])];
    add('fiscal', raw, confOf(rows), [...new Set(rows.map(evidenceId.budget))], `3년 평균 증가율 ${g.value == null ? '미상' : `${round1(g.value)}%`}, GDP 대비 ${latest ? `${round1(latest.gdp_pct!)}%(${latest.year})` : '미상'}`);
  } else add('fiscal', 0, 0, [], '국방비 자료 없음', true);

  // 주변국 압력: 인접국별 (신규 구매, 국방비 증가율) × 긴장도 중 최대
  const near = (input.neighbors || []).filter(n => n.tension != null);
  if (near.length) {
    const scored = near.map(n => {
      const buys = (input.neighborSignals || []).filter(s => s.country === n.neighbor && s.system === input.system && ['selected', 'contract', 'delivery'].includes(s.stage) && isRecent(yearOf(s), base));
      const ng = growth3y((input.neighborBudgets || []).filter(b => b.country === n.neighbor), base);
      return { n, buys, ng, v: (n.tension! / 100) * (0.5 * Math.min(1, buys.length / 3) + 0.5 * clamp01((ng.value ?? 0) / 10)) };
    }).sort((a, b) => b.v - a.v);
    const top = scored[0], tensionEst = !!(top.n.components as { estimated?: unknown } | null)?.estimated;
    add('neighbor', top.v, confOf([top.n, ...top.buys]), [evidenceId.neighbor(top.n), ...top.buys.map(evidenceId.signal), ...top.ng.rows.map(evidenceId.budget)], `${countryName(top.n.neighbor)} 긴장도 ${round1(top.n.tension!)}${tensionEst ? ' (추정)' : ''}, 최근 3년(${recentRange(base)}) 구매 ${top.buys.length}건, 국방비 증가율 ${top.ng.value == null ? '미상' : `${round1(top.ng.value)}%`}`, false, tensionEst);
  } else add('neighbor', 0, 0, [], '긴장도 산출 인접국 없음', true);

  // 소모 보충: 소모, 공여량 대비 재고, 기존 공급사 수주잔고
  const used = (input.consumption || []).filter(c => c.system === input.system);
  const stock = inv.reduce((s, i) => s + (i.quantity ?? 0), 0) || (input.forecast?.batches.filter(b => b.status !== 'retired' && b.status !== 'planned').reduce((s, b) => s + (b.qty ?? 0), 0) ?? 0);
  const incumbent = (input.capacity || []).filter(c => inv.some(i => sameModel(i.model, c.model)) && c.annual_output);
  if (used.length || incumbent.length) {
    const consumed = used.reduce((s, c) => s + c.quantity, 0);
    const r1 = used.length ? clamp01(2 * consumed / Math.max(1, consumed + stock)) : 0;
    const latestCap = incumbent.sort((a, b) => b.year - a.year)[0];
    const wait = latestCap ? (latestCap.backlog ?? 0) / latestCap.annual_output! : null;
    const raw = wait == null ? r1 : used.length ? 0.7 * r1 + 0.3 * clamp01(wait / 5) : clamp01(wait / 5);
    add('consumption', raw, confOf([...used, ...(latestCap ? [latestCap] : [])]), [...used.map(evidenceId.consumption), ...(latestCap ? [evidenceId.capacity(latestCap)] : [])], `소모와 공여 ${consumed}, 재고 ${stock}${wait == null ? '' : `, 기존 공급사 납기 ${round1(wait)}년분`}`);
  } else add('consumption', 0, 0, [], '소모, 공여, 수주잔고 자료 없음', true);

  // 경쟁 우위: 그룹사 최근 5년 수주, 이 국가의 경쟁사 수주, 납기 비교
  const links = (input.links || []).filter(l => l.system === input.system);
  const groupModels = links.filter(l => l.is_group), rivals = links.filter(l => !l.is_group);
  const isGroup = (s: SignalRow) => s.supplier === 'KOR' || groupModels.some(l => sameModel(s.model, l.model));
  const won = (input.systemSignals || signals).filter(s => s.system === input.system && ['contract', 'delivery'].includes(s.stage) && yearOf(s) >= base - 5);
  const groupWins = won.filter(isGroup), rivalHere = won.filter(s => s.country === input.country && !isGroup(s));
  // 경쟁사가 선정, 계약한 진행 사업도 이 국가 경쟁사 수주로 센다(같은 모델 신호와 중복 없이)
  const progRival = !!prog?.supplier && !/한화|hanwha/i.test(prog.supplier) && prog.supplier !== 'KOR' && !groupModels.some(l => sameModel(prog.model, l.model)) && !rivalHere.some(s => sameModel(s.model, prog.model));
  const rivalCount = rivalHere.length + (progRival ? 1 : 0);
  const capYears = (ms: SystemLinkRow[]) => { const rows = (input.capacity || []).filter(c => c.annual_output && ms.some(l => sameModel(c.model, l.model))); return rows.length ? { v: rows.reduce((s, c) => s + (c.backlog ?? 0) / c.annual_output!, 0) / rows.length, rows } : null; };
  const gCap = capYears(groupModels), rCap = capYears(rivals);
  if (groupWins.length || rivalCount || (gCap && rCap)) {
    const raw = 0.5 + (groupWins.length ? 0.25 : 0) + (gCap && rCap && gCap.v < rCap.v ? 0.25 : 0) - (rivalCount ? 0.5 : 0);
    const used2 = [...groupWins.slice(0, 5), ...rivalHere, ...(progRival ? [{ confidence: FORECAST_CONFIDENCE[met!.confidence] }] : []), ...(gCap?.rows || []), ...(rCap?.rows || [])];
    add('competition', raw, confOf(used2), [...groupWins.slice(0, 5).map(evidenceId.signal), ...rivalHere.map(evidenceId.signal), ...(progRival ? [`records:${met!.id}`] : []), ...(gCap?.rows || []).map(evidenceId.capacity), ...(rCap?.rows || []).map(evidenceId.capacity)], `그룹사 최근 5년 수주 ${groupWins.length}건, 이 국가 경쟁사 수주 ${rivalCount}건${progRival ? `(진행 사업 ${prog!.supplier} 포함)` : ''}${gCap && rCap ? `, 납기 ${round1(gCap.v)}년 대 경쟁사 ${round1(rCap.v)}년` : ''}`);
  } else add('competition', 0, 0, [], '수주와 납기 비교 자료 없음', true);

  // 접근성: 한국산 운용 → 1.0, 방산 협정만 → 0.6
  const facts = (input.tier?.tier_reasons?.facts || {}) as { koreanDeliveries?: number; defenseAgreement?: boolean; koreanEvidence?: string[] };
  if (input.tier) {
    const raw = (facts.koreanDeliveries ?? 0) > 0 ? 1 : facts.defenseAgreement ? 0.6 : 0;
    add('access', raw, input.tier.confidence ?? SOURCE_CONFIDENCE.specialist, [evidenceId.tier(input.tier), ...(facts.koreanEvidence || []).slice(0, 5)], `한국산 인도 ${facts.koreanDeliveries ?? 0}건${facts.defenseAgreement ? ', 방산 협정' : ''}`);
  } else add('access', 0, 0, [], '수출 등급 미판정', true);

  // 통과 조건과 계수
  const tier = input.tier?.tier ?? null;
  const reasons: TierReason[] = input.tier?.tier_reasons?.reasons || [];
  let gate: ScoreBreakdown['gate'] = { passed: true, reason: null, evidence: [] };
  if (tier === 3) gate = { passed: false, reason: `수출 불가 - ${cleanTierReason(reasons.filter(r => r.tier === 3).map(r => r.text).join(', ')) || '제재 또는 금수'}`, evidence: [evidenceId.tier(input.tier!)] };
  else if (input.domestic?.status === 'production') gate = { passed: false, reason: `동급 체계 독자 양산 - ${input.domestic.program || '프로그램 미상'}`, evidence: [evidenceId.domestic(input.domestic)] };
  const tierFactor = tier === 2 ? w.tier2 : tier === 1 ? w.tier1 : 1;
  const domesticFactor = input.domestic?.status === 'development' ? w.domestic_development : 1;
  const subtotal = round1(comps.reduce((s, c) => s + c.points, 0));
  const score = gate.passed ? round1(subtotal * tierFactor * domesticFactor) : 0;
  const evidenceIds = [...new Set([...comps.flatMap(c => c.evidence), ...gate.evidence, ...(input.domestic && domesticFactor !== 1 ? [evidenceId.domestic(input.domestic)] : [])])];
  return {
    country: input.country, system: input.system, baseYear: base, gate, tier, tierFactor, tierReasons: reasons, approvals: input.tier?.tier_reasons?.approvals || [],
    domestic: input.domestic?.status ?? null, domesticFactor, components: comps, subtotal, score,
    imminenceYear: imminence.length ? Math.min(...imminence) : null, grey: !gate.passed, evidenceIds,
    weights: Object.fromEntries(SCORE_FACTORS.map(f => [f.factor, w[f.factor]])),
    program: input.forecast?.program ?? null,
  };
}
