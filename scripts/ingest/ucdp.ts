/**
 * UCDP 전투 사망자(dyadic) 자료 → pair_events. 공개 내려받기 파일은 인증키가 필요 없다(UCDP API는 x-ucdp-access-token 필요).
 * - source='ucdp': 국가 간 분쟁(type 2) 정부 대 정부 쌍. 고객 등급의 '분쟁 당사국' 판정에도 쓴다.
 * - source='ucdp_intl': 그 밖에 양쪽 주 당사자가 모두 정부인 쌍(국제화된 내전 등). 긴장도에만 쓴다.
 * 사용: npm run ingest:ucdp -- [--dry-run] [--since 2015] [--file 받은.zip|.csv] [--url ...]
 */
import { unzipSync, strFromU8 } from 'fflate';
import type { PairEventRow } from '../../shared/types';
import { baseYear, countryId, isMain, load, parseCsv, readInput, runCli, type IngestOptions } from './common';

export const UCDP_BRD_URL = 'https://ucdp.uu.se/downloads/brd/ucdp-brd-dyadic-261-csv.zip';
export const UCDP_SOURCE = { id: 'ucdp_brd', title: 'UCDP Battle-Related Deaths Dataset (dyadic) v26.1', url: 'https://ucdp.uu.se/downloads/', confidence: 1 };

/** "Government of Russia (Soviet Union), Government of X" → 국가 ID 목록. 정부가 아닌 행위자는 빈 목록 */
export function governments(side: string): string[] {
  return side.split(/,\s*(?=Government of )/).map(s => s.trim()).filter(s => s.startsWith('Government of ')).map(s => countryId(s.slice('Government of '.length).replace(/\(.*?\)/g, '').trim())).filter((x): x is string => !!x);
}

export function normalizeUcdp(csv: string, since: number) {
  const [head, ...rows] = parseCsv(csv.replace(/^\uFEFF/, '')).filter(r => r.length > 1);
  const col = (n: string) => { const i = head.indexOf(n); if (i < 0) throw new Error(`UCDP CSV에 ${n} 열이 없습니다`); return i; };
  const c = { a: col('side_a'), b: col('side_b'), year: col('year'), best: col('bd_best'), type: col('type_of_conflict') };
  const sum = new Map<string, Partial<PairEventRow>>();
  for (const r of rows) {
    const year = Number(r[c.year]); if (!(year >= since)) continue;
    const as = governments(r[c.a]), bs = governments(r[c.b]);
    if (!as.length || !bs.length) continue;
    const source = r[c.type] === '2' ? 'ucdp' : 'ucdp_intl';
    for (const a of as) for (const b of bs) {
      if (a === b) continue;
      const [x, y] = [a, b].sort(), key = `${source}:${x}:${y}:${year}`;
      const row = sum.get(key) || { source, country: x, counterpart: y, period: String(year), fatalities: 0, events: 0 };
      row.fatalities! += Number(r[c.best]) || 0; row.events! += 1;
      sum.set(key, row);
    }
  }
  return [...sum.values()];
}

export async function ingestUcdp(opts: IngestOptions = {}) {
  const since = Number(opts.args?.since) || baseYear(opts) - 10;
  const url = typeof opts.args?.url === 'string' ? opts.args.url : UCDP_BRD_URL;
  const bytes = await readInput(opts, url);
  let csv: string;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes, { filter: f => f.name.toLowerCase().endsWith('.csv') });
    const name = Object.keys(files)[0]; if (!name) throw new Error('UCDP 압축 파일에 CSV가 없습니다');
    csv = strFromU8(files[name]);
  } else csv = new TextDecoder().decode(bytes);
  const rows = normalizeUcdp(csv, since);
  return load(opts, { ...UCDP_SOURCE, url }, { pair_events: rows }, [`${since}년 이후, 정부 대 정부 쌍 ${rows.length}건(events=dyad 수, fatalities=bd_best 합)`]);
}

if (isMain(import.meta.url)) await runCli('ucdp', ingestUcdp);
