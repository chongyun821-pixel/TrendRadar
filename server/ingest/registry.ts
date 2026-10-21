/** 수집 출처 목록: 이름·채우는 표·소요 시간·허용 인자와 실행 함수. CLI와 채팅 도구가 함께 쓴다. */
import type { CollectionTable } from '../collection';
import type { IngestOptions, IngestResult } from './common';
import { ingestSipriTransfers } from './sipri-transfers';
import { ingestSipriMilex } from './sipri-milex';
import { ingestSipriEmbargoes } from './sipri-embargoes';
import { ingestItar } from './itar';
import { ingestWorldBank } from './worldbank';
import { ingestUcdp } from './ucdp';
import { ingestGdelt } from './gdelt';
import { ingestOryx } from './oryx';
import { ingestTiers } from './tiers';
import { ingestTension } from './tension';

export type IngestParam = 'since' | 'year' | 'months' | 'side' | 'asOf' | 'countries';
export interface IngestSource {
  id: string; ko: string; fills: CollectionTable[]; sourceIds: string[];
  /** 대략 소요 시간(초). 채팅 도구 대기 시간 안내용 */
  seconds: number; params: IngestParam[]; after?: string[];
  run: (opts: IngestOptions) => Promise<IngestResult>;
}
export const INGEST_SOURCES: IngestSource[] = [
  { id: 'sipri-embargoes', ko: 'SIPRI 무기 금수(UN·EU·기타)', fills: ['export_controls'], sourceIds: ['sipri_embargoes'], seconds: 15, params: ['countries'], run: ingestSipriEmbargoes },
  { id: 'itar', ko: '미국 ITAR 126.1(d) 국가 목록', fills: ['export_controls'], sourceIds: ['itar_126_1'], seconds: 10, params: ['countries'], run: ingestItar },
  { id: 'sipri-transfers', ko: 'SIPRI 무기 이전(계약·인도, 보유 추정)', fills: ['signals', 'inventory'], sourceIds: ['sipri_transfers'], seconds: 30, params: ['since', 'year', 'countries'], run: ingestSipriTransfers },
  { id: 'sipri-milex', ko: 'SIPRI 국방비', fills: ['budgets'], sourceIds: ['sipri_milex'], seconds: 20, params: ['since', 'year', 'countries'], run: ingestSipriMilex },
  { id: 'worldbank', ko: 'World Bank 국방비·GDP', fills: ['budgets'], sourceIds: ['worldbank_wdi'], seconds: 120, params: ['since', 'year', 'countries'], run: ingestWorldBank },
  { id: 'ucdp', ko: 'UCDP 국가 간 무력 충돌 사망자', fills: ['pair_events'], sourceIds: ['ucdp_brd'], seconds: 20, params: ['since', 'year', 'countries'], run: ingestUcdp },
  { id: 'gdelt', ko: 'GDELT 국가 쌍 적대 이벤트(월별)', fills: ['pair_events'], sourceIds: ['gdelt_events'], seconds: 240, params: ['months', 'countries'], run: ingestGdelt },
  { id: 'oryx', ko: 'Oryx 러시아·우크라이나 장비 손실', fills: ['consumption'], sourceIds: ['oryx_ukraine'], seconds: 30, params: ['side'], run: ingestOryx },
  { id: 'tiers', ko: '고객 등급 판정(1·2·3세계)', fills: ['export_tiers', 'export_controls'], sourceIds: ['tier_rules_v1', 'ref_kr_controls'], seconds: 15, params: ['year', 'countries'], after: ['sipri-embargoes', 'itar', 'sipri-transfers', 'ucdp'], run: ingestTiers },
  { id: 'tension', ko: '인접국 긴장도 산출', fills: ['neighbors'], sourceIds: ['tension_v1'], seconds: 30, params: ['asOf', 'countries'], after: ['ucdp', 'gdelt', 'sipri-milex', 'sipri-transfers'], run: ingestTension },
];
export const ingestSource = (id: string) => INGEST_SOURCES.find(s => s.id === id);
