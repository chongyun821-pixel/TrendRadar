/** ifv는 화면 표기만 IFV로 바뀐 기존 장갑차 ID다. 저장된 기록과 호환되도록 ID를 유지한다. */
export type SystemKey = 'sph' | 'ifv' | 'sam' | 'mrl' | 'frigate' | 'ssk';
export const SYSTEM_KEYS = ['sph', 'ifv', 'sam', 'mrl', 'frigate', 'ssk'] as const satisfies readonly SystemKey[];
export type Category = 'red' | 'orange' | 'yellow' | 'blue' | 'gray';

export interface Source { t: string; u: string; y: number; publishedAt?: string | null; collectedAt?: string; filePath?: string; hash?: string; kind?: 'original' | 'search' | 'attachment'; excerpt?: string }
export interface Batch { model: string; introYear: number | null; qty: number | null; primary?: boolean; status?: 'in_service' | 'retired' | 'planned'; lifeExt?: number; covered?: boolean; est?: string[]; note?: string; src: string[] }
export interface Awarded { year: number; text: string; qty: number | null; deliveryEnd: number; covers: number; est?: string[]; src: string[] }
export interface Plan { start: number; end: number; qty: [number, number] | null; text: string; est?: string[]; src: string[] }
export interface Mro { year: number; text: string; lifeExt: number; est?: string[]; src: string[] }
export interface Signal { year: number; text: string; src: string[] }
/** 사업 단계: 선정 전(consideration·plan·tender)은 열린 경쟁, selected 이후(선정·계약·인도·완료)는 교체 수요를 채운 진행 사업 */
export const PROJECT_STAGES = ['consideration', 'plan', 'tender', 'selected', 'contract', 'delivery', 'completed', 'cancelled'] as const;
export type ProjectStage = typeof PROJECT_STAGES[number];
/**
 * 국가×체계의 개별 조달 사업. 연도·수량은 출처가 밝힌 값만 넣고 추정한 필드는 est에 이름을 적는다.
 * covers: 이 사업이 기존 운용 전력 교체 수요를 채우는 비율(0~1, 생략 시 1). selected는 contractYear가 계약 목표 연도다.
 */
export interface Project {
  id: string; buyer: string; supplier: string; stage: ProjectStage; text: string;
  model?: string; qty?: number; amount?: number; currency?: string;
  decisionYear?: number; contractYear?: number; deliveryStart?: number; deliveryEnd?: number;
  covers?: number; reserve?: string; asOf?: string; est?: string[]; src: string[];
}
/** 예측·점수·보고서가 함께 쓰는 사업 현황 요약(shared/forecast.ts programOf) */
export interface ProgramView {
  id: string; stage: ProjectStage; stageKo: string; supplier: string | null; model: string | null; reserve: string | null;
  qty: number | null; amount: number | null; currency: string | null;
  decisionYear: number | null; contractYear: number | null; deliveryStart: number | null; deliveryEnd: number | null;
  /** 교체 수요를 채운 비율. open이면 0 */
  covers: number;
  /** true = 선정 전 경쟁(사업 기회), false = 공급자 선정 이후(교체 수요 충족) */
  open: boolean;
  reason: string; text: string; est: string[]; src: string[];
}
export interface ProgramRecord {
  id: string; country: string; system: SystemKey;
  batches: Batch[]; awarded?: Awarded; plan?: Plan; mro?: Mro[]; signals?: Signal[];
  ratio?: [number, number]; ratioEst?: boolean; src: string[];
  projects?: Project[];
  analysis?: { facts: string[]; estimates: string[]; conflicts: string[]; unknowns: string[]; opportunity?: string };
}
export interface SystemMeta { ko: string; unit: string; designLife: number; unitCost: [number, number]; unitCostEst: boolean; unitCostBasis: string; costSrc: string[]; hanwha: string[];
  /** 설계 수명(designLife)의 출처 ID. 하나라도 있으면 수명을 추정으로 표시하지 않는다 */
  lifeSrc?: string[] }
export interface CountryMeta { ko: string; flag: string; lat: number; lon: number }
export interface Seed {
  meta: { baseYear: number; collected: string; fx: Record<string, number | string>; note: string };
  systems: Record<SystemKey, SystemMeta>;
  countries: Record<string, CountryMeta>;
  sources: Record<string, Source>;
  records: ProgramRecord[];
}

export interface BatchCalc { model: string; introYear: number | null; qty: number | null; life: number; ext: number; year: number | null; primary?: boolean; status?: Batch['status']; est: string[] }
export interface Forecast {
  id: string; country: string; countryKo: string; flag: string; system: SystemKey; systemKo: string; unit: string;
  status: 'open' | 'plan' | 'next' | 'none';
  window: [number, number] | null; remaining: number | null; category: Category; score: number;
  qty: [number, number] | null; krw: [number, number] | null; size: number; // 미확인 수량·금액은 null. size = 0..1 (log scale)
  confidence: '상' | '중' | '하'; nSources: number; latestSource: number; estCount: number;
  current: BatchCalc | null; batches: BatchCalc[];
  calc: string[]; sources: Source[];
  qtyEst: boolean; krwEst: boolean; lifeEst: boolean;
  /** 진행 중·선정 전 사업 현황. 없으면 null */
  program?: ProgramView | null;
}

/* ───────── 데이터 수집 테이블 행 (db/migrations/004) ───────── */
export type Tier = 1 | 2 | 3;
export const SIGNAL_STAGES = ['review', 'tender', 'selection', 'contract', 'delivery', 'cancelled'] as const;
export type SignalStage = typeof SIGNAL_STAGES[number];
/** 모든 수치 행의 공통 근거: 출처 ID, 신뢰도(공식·DB 1.0, 전문 매체 0.7, 일반 뉴스·X 0.4), 수집 시각 */
export interface Provenance { source_id?: string | null; confidence?: number | null; collected_at?: string | null }
export interface SystemLinkRow extends Provenance { system: SystemKey; model: string; maker?: string | null; is_group: boolean; relation: 'group' | 'competitor' | 'substitute' | 'parent' | string }
export interface TierReason { code: string; text: string; tier: Tier; evidence: string[] }
export interface TierRecord { reasons: TierReason[]; facts: Record<string, unknown>; approvals?: string[] }
export interface ExportTierRow extends Provenance { country: string; system: SystemKey | '*'; tier: Tier; tier_reasons: TierRecord; tier_checked_at: string }
export interface ExportControlRow extends Provenance { id: string; country: string; regime: string; name: string; status: 'active' | 'suspended' | 'lifted' | 'partial'; started?: string | null; ended?: string | null; url?: string | null }
export interface NeighborRow extends Provenance { country: string; neighbor: string; kind: 'land' | 'sea' | 'rival'; tension?: number | null; components?: Record<string, unknown> | null; computed_at?: string | null }
export interface InventoryRow extends Provenance { id: string; country: string; system: SystemKey; model: string; quantity?: number | null; delivered_year?: number | null; service_life?: number | null; retire_year?: number | null; supplier?: string | null }
export interface BudgetRow extends Provenance { country: string; year: number; usd_m?: number | null; gdp_pct?: number | null; yoy_pct?: number | null; gdp_usd_m?: number | null }
export interface SignalRow extends Provenance { id: string; country: string; system: SystemKey; model?: string | null; maker?: string | null; supplier?: string | null; stage: SignalStage; quantity?: number | null; value_usd_m?: number | null; expected_year?: number | null; published_at?: string | null; url?: string | null; note?: string | null }
export interface ConsumptionRow extends Provenance { id: string; conflict: string; user_country: string; target_country?: string | null; system: SystemKey; model?: string | null; quantity: number; period?: string | null; kind: 'loss' | 'donation' | 'expenditure' }
export interface CapacityRow extends Provenance { maker: string; model: string; year: number; annual_output?: number | null; backlog?: number | null }
export interface DomesticRow extends Provenance { country: string; system: SystemKey; status: 'none' | 'development' | 'production'; program?: string | null }
export interface WeightRow { factor: string; weight: number; note?: string | null }
export interface PairEventRow extends Provenance { source: string; country: string; counterpart: string; period: string; events?: number | null; fatalities?: number | null; goldstein?: number | null }

export type ScoreFactor = 'intent' | 'aging' | 'fiscal' | 'neighbor' | 'consumption' | 'competition' | 'access';
export interface ScoreComponent { factor: ScoreFactor; label: string; weight: number; raw: number; confidence: number; points: number; missing: boolean; detail: string; evidence: string[];
  /** 추정값(인도 연도 추정 보유 행, 근거 없는 긴장도)이 들어간 항목 */
  estimated?: boolean }
export interface ScoreBreakdown {
  country: string; system: SystemKey; baseYear: number;
  gate: { passed: boolean; reason: string | null; evidence: string[] };
  tier: Tier | null; tierFactor: number; tierReasons: TierReason[]; approvals: string[];
  domestic: DomesticRow['status'] | null; domesticFactor: number;
  components: ScoreComponent[]; subtotal: number; score: number;
  imminenceYear: number | null; grey: boolean; evidenceIds: string[]; weights: Record<string, number>;
  /** 진행 중 사업으로 교체 수요가 충족됐는지 판단한 근거(예측과 같은 값) */
  program?: ProgramView | null;
}
