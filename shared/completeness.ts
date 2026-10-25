import { computeForecast, isCurrentBatch } from './forecast';
import type { ProgramRecord, Seed, SystemKey } from './types';

/** 실제 지도 필드를 기준으로 본다. 사업 설명이나 record 존재만으로 완료로 보지 않는다. */
export function procurementCoverage(record: ProgramRecord | undefined, data: Seed, system: SystemKey) {
  const forecast = record ? computeForecast(record, data) : null;
  const active = record?.batches.filter(b => isCurrentBatch(b)) || [];
  const missing = [
    ...(!forecast?.current ? ['현재 운용 장비(model, 운용 상태)'] : []),
    ...(!forecast?.window ? ['도입 연도 또는 공개 사업 일정'] : []),
    ...(!forecast?.qty ? ['보유 수량과 사업 수량'] : []),
    ...(forecast?.window && active.some(b => b.introYear == null) ? ['일부 현역 배치의 도입 연도'] : []),
    ...(forecast?.qty && active.some(b => b.qty == null) ? ['일부 현역 장비의 보유 수량'] : []),
    ...(!forecast?.nSources ? ['보존한 원문 근거'] : []),
  ];
  return {
    system, systemKo: data.systems[system].ko, recordExists: !!record,
    status: !record ? 'missing' : missing.length ? 'partial' : 'ready',
    current: forecast?.current ?? null, window: forecast?.window ?? null,
    quantity: forecast?.qty ?? null, amount: forecast?.krw ?? null, missing,
    knownLimitations: record?.analysis?.unknowns ?? [],
  };
}
export function countryCoverage(data: Seed, country: string, system?: SystemKey | null) {
  return (system ? [system] : Object.keys(data.systems) as SystemKey[]).map(s => procurementCoverage(data.records.find(r => r.country === country && r.system === s), data, s));
}
