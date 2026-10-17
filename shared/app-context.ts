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
  activeView: 'map' | 'report';
  mode: SystemKey | null;
  flat: boolean;
  focus: string | null;
  filters: { system: SystemKey | null };
  report: ReportRef | null;
  dataVersion: number;
}
