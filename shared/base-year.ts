/**
 * 판단 기준 연도와 '최근 3년' 범위.
 * 기준 연도는 운영 데이터 meta.baseYear 하나만 쓴다(현재 2026). 화면, 보고서, 예측, 점수, 조사 양식 모두 같은 값을 쓰고, 시계(new Date)로 정하지 않는다.
 */
import type { Seed } from './types';

export const baseYearOf = (data: Pick<Seed, 'meta'>) => data.meta.baseYear;
/** '최근 3년' = 기준 연도를 포함한 4개년(base-3..base). 기준 2026이면 2023~2026 */
export const RECENT_YEARS_BACK = 3;
export const recentFrom = (base: number) => base - RECENT_YEARS_BACK;
export const isRecent = (year: number, base: number) => year >= recentFrom(base);
export const recentRange = (base: number) => `${recentFrom(base)}~${base}`;
export const recentLabel = (base: number) => `${recentRange(base)}(기준 연도 포함 4개년)`;
