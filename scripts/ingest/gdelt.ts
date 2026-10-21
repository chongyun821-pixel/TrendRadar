/**
 * GDELT 1.0 일별 이벤트 파일 → pair_events(source='gdelt', 월별 국가 쌍 적대 이벤트 수·평균 Goldstein). 인증키 불필요.
 * 하루 파일이 5~7MB라 달마다 표본일(기본 1·8·15·22일)만 받아 그 달 일수로 환산한다. 이미 적재된 달은 건너뛴다(--force로 다시).
 * 적대 이벤트: CAMEO 근본 코드 13(위협)·15(무력 시위)·16(관계 축소·제재)·17(강압)·18(공격)·19(교전)·20(대량 폭력).
 * 사용: npm run ingest:gdelt -- [--dry-run] [--months 12] [--to 2026-09] [--days 1,8,15,22] [--force] [--file 일별.zip]
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { PairEventRow } from '../../shared/types';
import { repository } from '../../server/store';
import { selectRows } from '../../server/collection';
import { CAMEO_TO_ID, countryIndex, fetchRetry, isMain, load, runCli, type IngestOptions } from './common';
import { readFileSync } from 'node:fs';

export const GDELT_SOURCE = { id: 'gdelt_events', title: 'GDELT 1.0 Event Database (daily export, 표본일 환산)', url: 'https://data.gdeltproject.org/events/index.html', confidence: 0.7 };
export const gdeltDayUrl = (day: string) => `https://data.gdeltproject.org/events/${day.replace(/-/g, '')}.export.CSV.zip`;
export const HOSTILE_ROOTS = new Set(['13', '15', '16', '17', '18', '19', '20']);
const COL = { actor1: 7, actor2: 17, root: 28, goldstein: 30 };

export interface DayTally { events: number; goldsteinSum: number }
/** 하루치 탭 구분 파일 → 국가 쌍(정렬)별 적대 이벤트 수와 Goldstein 합 */
export function tallyDay(tsv: string, known = countryIndex().ids): Map<string, DayTally> {
  const out = new Map<string, DayTally>();
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const f = line.split('\t');
    if (!HOSTILE_ROOTS.has(f[COL.root])) continue;
    const a = CAMEO_TO_ID[f[COL.actor1]] || f[COL.actor1], b = CAMEO_TO_ID[f[COL.actor2]] || f[COL.actor2];
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) continue;
    const key = [a, b].sort().join('|'), t = out.get(key) || { events: 0, goldsteinSum: 0 };
    t.events++; t.goldsteinSum += Number(f[COL.goldstein]) || 0; out.set(key, t);
  }
  return out;
}
export const unzipText = (bytes: Uint8Array) => { const files = unzipSync(bytes); const name = Object.keys(files)[0]; if (!name) throw new Error('빈 압축 파일'); return strFromU8(files[name]); };

/** 표본일 집계를 달 단위로 환산한다(이벤트 수 × 그 달 일수 / 받은 날 수, Goldstein은 가중 평균) */
export function monthRows(month: string, days: Map<string, DayTally>[]): Partial<PairEventRow>[] {
  const [y, m] = month.split('-').map(Number), inMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const sum = new Map<string, DayTally>();
  for (const day of days) for (const [k, t] of day) { const s = sum.get(k) || { events: 0, goldsteinSum: 0 }; s.events += t.events; s.goldsteinSum += t.goldsteinSum; sum.set(k, s); }
  return [...sum].map(([k, t]) => { const [country, counterpart] = k.split('|'); return { source: 'gdelt', country, counterpart, period: month, events: Math.round(t.events * inMonth / Math.max(1, days.length)), goldstein: Math.round(t.goldsteinSum / t.events * 100) / 100 }; });
}
export function monthsEnding(to: string, n: number): string[] {
  const [y, m] = to.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1 - (n - 1 - i), 1)).toISOString().slice(0, 7));
}

export async function ingestGdelt(opts: IngestOptions = {}) {
  const today = (opts.now || new Date().toISOString()).slice(0, 10);
  const lastFull = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7); // 지난달
  const to = typeof opts.args?.to === 'string' ? opts.args.to : lastFull;
  const sampleDays = String(opts.args?.days || '1,8,15,22').split(',').map(Number).filter(d => d >= 1 && d <= 28);
  const notes: string[] = [];
  if (opts.file) {
    const day = typeof opts.args?.day === 'string' ? opts.args.day : `${to}-01`;
    const rows = monthRows(day.slice(0, 7), [tallyDay(unzipText(new Uint8Array(readFileSync(opts.file))))]);
    return load(opts, GDELT_SOURCE, { pair_events: rows }, [`파일 1개(${day})를 그 달 표본으로 환산`]);
  }
  let months = monthsEnding(to, Number(opts.args?.months) || 12);
  if (!opts.args?.force && !opts.dryRun) {
    const have = new Set((await selectRows(opts.repo || repository(), 'pair_events', { source: 'gdelt', period: months })).map(r => r.period));
    const skipped = months.filter(m => have.has(m)); months = months.filter(m => !have.has(m));
    if (skipped.length) notes.push(`이미 적재된 달 건너뜀: ${skipped.join(', ')}`);
  }
  const rows: Partial<PairEventRow>[] = [];
  for (const month of months) {
    const tallies: Map<string, DayTally>[] = [];
    for (const d of sampleDays) {
      const day = `${month}-${String(d).padStart(2, '0')}`;
      try { tallies.push(tallyDay(unzipText(new Uint8Array(await (await fetchRetry(opts.fetch || fetch, gdeltDayUrl(day), {}, { timeoutMs: 120000 })).arrayBuffer())))); }
      catch (e: any) { notes.push(`${day} 실패: ${e?.message || e}`); }
    }
    opts.log?.(`${month}: 표본 ${tallies.length}/${sampleDays.length}일`);
    if (tallies.length) rows.push(...monthRows(month, tallies));
  }
  notes.push(`대상 달 ${months.join(', ') || '없음'}, 표본일 ${sampleDays.join('·')}일`);
  return load(opts, GDELT_SOURCE, { pair_events: rows }, notes);
}

if (isMain(import.meta.url)) await runCli('gdelt', ingestGdelt);
