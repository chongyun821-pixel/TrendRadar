import type { SystemKey } from './types';

export interface AppliedCommandVersion { expectedVersion: number; version: number }

/** 같은 실행에서 확인된 화면 변경만 이어받는다. 사용자 변경으로 생긴 버전은 포함하지 않는다. */
export function commandVersionMatches(expected: number, current: number, applied: AppliedCommandVersion[]) {
  const reachable = new Set([expected]);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of applied) if (reachable.has(edge.expectedVersion) && !reachable.has(edge.version)) {
      reachable.add(edge.version); changed = true;
    }
  }
  return reachable.has(current);
}

export interface ReportRef {
  id: string;
  country: string | null;
  system: SystemKey | null;
  kind: 'country-analysis';
  basisDate: string;
  dataVersion: number;
}
export interface AppContext {
  screenId: string;
  version: number;
  conversationId: string | null;
  model: string;
  /** CLI 모델·추론 강도(코덱스·그록 빌드만) */
  modelOptions?: { model?: string; effort?: string };
  activeView: 'map' | 'report';
  mode: SystemKey | null;
  flat: boolean;
  focus: string | null;
  filters: { system: SystemKey | null };
  report: ReportRef | null;
  dataVersion: number;
}
