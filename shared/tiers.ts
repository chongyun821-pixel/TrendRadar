/** 고객 등급(수출 가능, 조건부 수출 가능, 수출 불가) 판정 규칙 (요구서 4장). 순수 함수이며 판정 근거를 tier_reasons에 남긴다. */
import type { ExportControlRow, SystemKey, Tier, TierReason, TierRecord } from './types';

/** 등급 표기. 저장 값은 1, 2, 3 그대로 둔다 */
export const TIER_KO: Record<Tier, string> = { 1: '수출 가능', 2: '조건부 수출 가능', 3: '수출 불가' };
export const tierLabel = (tier?: number | null) => tier === 1 || tier === 2 || tier === 3 ? TIER_KO[tier] : '미판정';

/** 수출 불가로 보는 제재, 금수 체계. MANUAL은 data/reference/export-controls.json의 수기 지정(사유 포함)이다. US-ITAR-126.1(d)(2)는 부분 제한이라 체계별 미국산 부품 여부로 다시 본다 */
export const BLOCKING_REGIMES = ['UN', 'EU', 'US', 'US-ITAR-126.1(d)(1)', 'KR', 'MANUAL'] as const;
export const PARTIAL_REGIMES = ['US-ITAR-126.1(d)(2)'] as const;
export const REGIME_KO: Record<string, string> = { UN: 'UN 안보리 무기 금수', EU: 'EU 무기 금수', US: '미국 제재', 'US-ITAR-126.1(d)(1)': '미국 ITAR 126.1(d)(1) 거부 정책국', 'US-ITAR-126.1(d)(2)': '미국 ITAR 126.1(d)(2) 제한국', KR: '한국 수출통제 대상국', MANUAL: '수기 지정', OTHER: '기타 다자 금수' };

export function cleanTierReason(text: string): string {
  return text
    .replace(/^수기 지정(?:\(수출 불가\))?: 수기 지정(?: 수출 불가)?: /, '수기 지정: ')
    .replace(/^수기 지정 수출 불가: /, '수기 지정: ')
    .replace(/, 수기 지정(?:\(수출 불가\))?(?: 수출 불가)?: /g, ', ')
    .replace(/: /g, ', ')
    .replace(/(?:, ){2,}/g, ', ')
    .trim();
}

export interface TierFacts {
  country: string;
  /** 이 국가를 대상으로 하는 금수, 제재, 수출통제 행 */
  controls: ExportControlRow[];
  /** SIPRI 이전 DB의 한국산 인도, 계약 건수와 근거 ID */
  koreanDeliveries: number; koreanEvidence?: string[];
  defenseAgreement?: boolean; agreementEvidence?: string[];
  /** '최근 3년'(기준 연도 포함 4개년) UCDP 국가 간, 국제화 분쟁 당사국 여부와 그 연도 범위(예: 2023~2026) */
  conflictParty: boolean; conflictWindow?: string; conflictEvidence?: string[];
}
/** 체계별 미국산 부품(ITAR) 사용 여부. null이면 미확인이며 등급을 바꾸지 않고 확인 필요로 남긴다 */
export interface ComponentControl { system: SystemKey; usItar: boolean | null; note?: string; evidence?: string[] }

const controlEvidence = (c: ExportControlRow) => `export_controls:${c.id}`;

export function classifyTier(facts: TierFacts, component?: ComponentControl | null): { tier: Tier; record: TierRecord } {
  const reasons: TierReason[] = [], approvals: string[] = [];
  const active = facts.controls.filter(c => c.country === facts.country && (c.status === 'active' || c.status === 'partial'));
  for (const c of active) {
    if ((BLOCKING_REGIMES as readonly string[]).includes(c.regime) && c.status === 'partial') { reasons.push({ code: `partial:${c.regime}`, text: `${REGIME_KO[c.regime] || c.regime} 일부 대상(비구속), ${c.name}`, tier: 2, evidence: [controlEvidence(c)] }); approvals.push(`${c.name} 적용 범위(정부군 대상 여부) 확인`); }
    else if ((BLOCKING_REGIMES as readonly string[]).includes(c.regime)) reasons.push({ code: `embargo:${c.regime}`, text: `${REGIME_KO[c.regime] || c.regime}, ${c.name}`, tier: 3, evidence: [controlEvidence(c)] });
    else if ((PARTIAL_REGIMES as readonly string[]).includes(c.regime)) {
      if (component?.usItar) reasons.push({ code: 'itar-component', text: `${REGIME_KO[c.regime]}이며 체계에 미국산 부품 사용`, tier: 3, evidence: [controlEvidence(c), ...(component.evidence || [])] });
      else { reasons.push({ code: `restricted:${c.regime}`, text: `${REGIME_KO[c.regime]}, ${c.name}`, tier: 2, evidence: [controlEvidence(c)] }); approvals.push('미국산 부품 포함 여부 확인과 미국 국무부 재수출 승인 검토'); }
    } else { reasons.push({ code: `embargo:${c.regime}`, text: `${REGIME_KO[c.regime] || REGIME_KO.OTHER}, ${c.name}`, tier: 2, evidence: [controlEvidence(c)] }); approvals.push(`${c.name} 적용 범위 확인`); }
  }
  if (!reasons.some(r => r.tier === 3)) {
    if (!facts.koreanDeliveries && !facts.defenseAgreement) { reasons.push({ code: 'no-history', text: '한국과 방산 협정이나 한국산 무기 수입 이력 없음', tier: 2, evidence: [] }); approvals.push('정부 간 협력 경로(방산 협정, G2G) 확인'); }
    if (facts.conflictParty) { reasons.push({ code: 'conflict-party', text: `최근 3년${facts.conflictWindow ? `(${facts.conflictWindow})` : ''} 분쟁 당사국`, tier: 2, evidence: facts.conflictEvidence || [] }); approvals.push('분쟁 당사국 수출 허가 심사(대외무역법, 방위사업법)'); }
    if (component?.usItar) { reasons.push({ code: 'us-components', text: '미국산 부품 사용으로 재수출 승인 필요', tier: 2, evidence: component.evidence || [] }); approvals.push('미국 ITAR 재수출 승인(DSP-5/제3국 이전 동의)'); }
  }
  if (component && component.usItar == null) approvals.push(`${component.system} 체계의 미국산 부품 사용 여부 미확인`);
  const tier: Tier = reasons.some(r => r.tier === 3) ? 3 : reasons.some(r => r.tier === 2) ? 2 : 1;
  if (tier === 1) reasons.push({ code: 'clear', text: `제재나 금수 없음, ${facts.koreanDeliveries ? `한국산 인도 ${facts.koreanDeliveries}건` : '한국과 방산 협정'}`, tier: 1, evidence: [...(facts.koreanEvidence || []).slice(0, 5), ...(facts.agreementEvidence || [])] });
  return { tier, record: { reasons, approvals: [...new Set(approvals)], facts: { koreanDeliveries: facts.koreanDeliveries, koreanEvidence: (facts.koreanEvidence || []).slice(0, 20), defenseAgreement: !!facts.defenseAgreement, conflictParty: facts.conflictParty, controls: active.map(c => c.id), usItar: component?.usItar ?? null } } };
}

/** 국가 단위 등급(system='*')과 체계별 등급을 함께 만든다. 체계별 등급은 국가 등급보다 낮아지지 않는다 */
export function classifyCountry(facts: TierFacts, components: ComponentControl[]): { system: SystemKey | '*'; tier: Tier; record: TierRecord }[] {
  const country = classifyTier(facts, null);
  return [{ system: '*', ...country }, ...components.map(c => {
    const r = classifyTier(facts, c);
    return r.tier < country.tier ? { system: c.system, ...country } : { system: c.system, ...r };
  })];
}
