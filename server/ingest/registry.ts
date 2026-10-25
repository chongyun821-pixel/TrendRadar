/** 수집 출처 목록: 이름, 채우는 표, 소요 시간, 허용 인자와 실행 함수. CLI와 채팅 도구가 함께 쓴다. */
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
  /** 실패 시 모델이 직접 읽을 원문 쪽 주소와 뽑을 내용. save: apply(조사 반영 도구로 반영 가능), source(원문 보존, 답변만), derived(선행 수집으로 계산) */
  fallback: { url?: string; what: string; save: 'apply' | 'source' | 'derived' };
}
export const INGEST_SOURCES: IngestSource[] = [
  { id: 'sipri-embargoes', ko: 'SIPRI 무기 금수(UN, EU, 기타)', fills: ['export_controls'], sourceIds: ['sipri_embargoes'], seconds: 15, params: ['countries'], fallback: { url: 'https://www.sipri.org/databases/embargoes', what: '국가별 무기 금수(UN, EU, 기타) 시행 기관, 시작, 종료 연도', save: 'source' }, run: ingestSipriEmbargoes },
  { id: 'itar', ko: '미국 ITAR 126.1(d) 국가 목록', fills: ['export_controls'], sourceIds: ['itar_126_1'], seconds: 10, params: ['countries'], fallback: { url: 'https://www.law.cornell.edu/cfr/text/22/126.1', what: '22 CFR 126.1(d) 거부 정책 국가 목록과 조항', save: 'source' }, run: ingestItar },
  { id: 'sipri-transfers', ko: 'SIPRI 무기 이전(계약, 인도, 보유 추정)', fills: ['signals', 'inventory'], sourceIds: ['sipri_transfers'], seconds: 30, params: ['since', 'year', 'countries'], fallback: { url: 'https://armstransfers.sipri.org/ArmsTransfer/TransferRegister', what: '수령국, 공급국, 무기 명칭, 주문 연도, 수량, 인도 연도(Trade Register)', save: 'apply' }, run: ingestSipriTransfers },
  { id: 'sipri-milex', ko: 'SIPRI 국방비', fills: ['budgets'], sourceIds: ['sipri_milex'], seconds: 20, params: ['since', 'year', 'countries'], fallback: { url: 'https://www.sipri.org/databases/milex', what: '국가별 연도 국방비(미 달러 고정가)와 GDP 대비 비율', save: 'source' }, run: ingestSipriMilex },
  { id: 'worldbank', ko: 'World Bank 국방비, GDP', fills: ['budgets'], sourceIds: ['worldbank_wdi'], seconds: 120, params: ['since', 'year', 'countries'], fallback: { url: 'https://data.worldbank.org/indicator/MS.MIL.XPND.GD.ZS', what: '국가별 연도 국방비 GDP 비율(MS.MIL.XPND.GD.ZS), 국방비(MS.MIL.XPND.CD)', save: 'source' }, run: ingestWorldBank },
  { id: 'ucdp', ko: 'UCDP 국가 간 무력 충돌 사망자', fills: ['pair_events'], sourceIds: ['ucdp_brd'], seconds: 20, params: ['since', 'year', 'countries'], fallback: { url: 'https://ucdp.uu.se/downloads/', what: '국가 간 충돌 쌍별 연도 전투 사망자(UCDP BRD dyadic)', save: 'source' }, run: ingestUcdp },
  { id: 'gdelt', ko: 'GDELT 국가 쌍 적대 이벤트(월별)', fills: ['pair_events'], sourceIds: ['gdelt_events'], seconds: 240, params: ['months', 'countries'], fallback: { url: 'https://data.gdeltproject.org/events/index.html', what: '국가 쌍별 월간 적대 이벤트 수, Goldstein 점수', save: 'source' }, run: ingestGdelt },
  { id: 'oryx', ko: 'Oryx 러시아, 우크라이나 장비 손실', fills: ['consumption'], sourceIds: ['oryx_ukraine'], seconds: 30, params: ['side'], fallback: { url: 'https://www.oryxspioenkop.com/2022/02/attack-on-europe-documenting-equipment.html', what: '장비 종류별 파괴, 손상, 포획 수량(러시아, 우크라이나는 별도 문서)', save: 'source' }, run: ingestOryx },
  { id: 'tiers', ko: '고객 등급 판정(수출 가능, 조건부, 불가)', fills: ['export_tiers', 'export_controls'], sourceIds: ['tier_rules_v1', 'ref_kr_controls'], seconds: 15, params: ['year', 'countries'], after: ['sipri-embargoes', 'itar', 'sipri-transfers', 'ucdp'], fallback: { what: '선행 수집 결과로 계산하는 고객 등급', save: 'derived' }, run: ingestTiers },
  { id: 'tension', ko: '인접국 긴장도 산출', fills: ['neighbors'], sourceIds: ['tension_v1'], seconds: 30, params: ['asOf', 'countries'], after: ['ucdp', 'gdelt', 'sipri-milex', 'sipri-transfers'], fallback: { what: '선행 수집 결과로 계산하는 인접국 긴장도', save: 'derived' }, run: ingestTension },
];
export const ingestSource = (id: string) => INGEST_SOURCES.find(s => s.id === id);
