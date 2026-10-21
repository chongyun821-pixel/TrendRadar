import type { SystemKey } from './types';

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
