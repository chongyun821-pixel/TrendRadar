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
