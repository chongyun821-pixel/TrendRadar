import type { MapDisplay } from './map-display';
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
  /** 브라우저 탭 ID(화면 허브 연결) */
  screenId: string;
  conversationId: string | null;
  model: string;
  /** CLI 모델·추론 강도(코덱스·그록 빌드만) */
  modelOptions?: { model?: string; effort?: string };
  activeView: 'map' | 'report';
  mode: SystemKey | null;
  flat: boolean;
  focus: string | null;
  filters: { system: SystemKey | null };
  /** 챗봇 표시 조정(숨김·특정 국가만·강조·빗금·막대·범례) */
  display?: MapDisplay;
  report: ReportRef | null;
  dataVersion: number;
  /** 탭이 백그라운드(브라우저가 숨김 전환 때 알린다) */
  hidden?: boolean;
}
