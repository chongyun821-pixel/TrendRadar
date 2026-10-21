/** 판단 점수(요구서 6장) 조회: 수집 테이블 + 기존 기록 예측을 묶어 shared/forecast.ts의 computeScore로 계산한다. */
import type { Repository } from './store';
import type { ScoreBreakdown, Seed, SystemKey } from '../shared/types';
import { computeForecast, computeScore } from '../shared/forecast';
import { inputsFor, scoringBundle } from './collection';

export interface ScoredCase extends ScoreBreakdown { countryKo: string; systemKo: string; recordId: string | null }

/** 한 체계의 국가별 점수. countries를 주면 그 나라만, 없으면 기록·등급·신호가 있는 나라 전체 */
export async function scoreSystem(repo: Repository, data: Seed, system: SystemKey, countries?: string[]): Promise<ScoredCase[]> {
  const bundle = await scoringBundle(repo, system);
  const base = data.meta.baseYear, designLife = data.systems[system]?.designLife;
  const ids = countries?.length ? countries : [...new Set([
    ...data.records.filter(r => r.system === system).map(r => r.country),
    ...bundle.tiers.filter(t => data.countries[t.country]).map(t => t.country),
    ...bundle.signals.map(s => s.country), ...bundle.inventory.map(i => i.country),
  ])].sort();
  return ids.map(country => {
    const record = data.records.find(r => r.country === country && r.system === system) || null;
    const forecast = record ? computeForecast(record, data) : null;
    const breakdown = computeScore({ ...inputsFor(bundle, country), forecast, designLife }, base);
    return { ...breakdown, countryKo: data.countries[country]?.ko ?? country, systemKo: data.systems[system]?.ko ?? system, recordId: record?.id ?? null };
  });
}

export async function scoreCase(repo: Repository, data: Seed, country: string, system: SystemKey): Promise<ScoredCase> {
  return (await scoreSystem(repo, data, system, [country]))[0];
}

/** 지도·목록용 요약(점수, 회색 여부, 임박 연도, 통과 실패 사유) */
export const scoreSummary = (s: ScoredCase) => ({ country: s.country, system: s.system, score: s.score, grey: s.grey, tier: s.tier, gate: s.gate.reason, imminenceYear: s.imminenceYear });

/** 보고서 양식 evidenceTable 형식의 케이스별 근거 표 */
export function evidenceTable(s: ScoredCase) {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return {
    title: `${s.countryKo} · ${s.systemKo} 근거 표`,
    header: {
      통과조건: s.gate.passed ? '통과' : `제외 — ${s.gate.reason}`,
      고객등급: s.tier ? `${s.tier}세계 (계수 ${s.tierFactor})` : `미판정 (계수 ${s.tierFactor})`,
      독자개발: s.domestic ? `${({ none: '없음', development: '개발 중', production: '양산' } as const)[s.domestic]} (계수 ${s.domesticFactor})` : '자료 없음',
      판단점수: s.gate.passed ? `${s.score}/100 (항목 합 ${s.subtotal})` : '0 (제외)',
      승인필요: s.approvals.length ? s.approvals : ['없음'],
    },
    columns: ['항목', '비중', '원점수', '출처 신뢰도', '점수', '판단 내용', '근거 ID'],
    rows: s.components.map(c => [c.label, c.weight, c.missing ? '자료 없음' : pct(c.raw), c.missing ? '—' : c.confidence, c.points, c.detail, c.evidence.join(', ') || '—']),
  };
}
export function evidenceTableMarkdown(s: ScoredCase) {
  const t = evidenceTable(s), cell = (v: unknown) => String(v).replace(/\|/g, '\\|');
  return [`**${t.title}**`, '', ...Object.entries(t.header).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join('; ') : v}`), '',
    `| ${t.columns.join(' | ')} |`, `|${t.columns.map(() => '---').join('|')}|`, ...t.rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}
