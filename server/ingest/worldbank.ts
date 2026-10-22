/**
 * World Bank 지표 API → budgets 보완. SIPRI 값이 있으면 유지하고 빈 칸(usd_m·gdp_pct)만 채우며 GDP(US$ 백만)는 항상 갱신한다.
 * 인증키 불필요. 응답이 느려(30초 이상) 재시도한다.
 * CLI: npm run ingest:worldbank -- [--dry-run] [--since 2010] [--file 응답묶음.json]
 */
import type { BudgetRow } from '../../shared/types';
import { collectionYear, countryIndex, fetchRetry, load, text, type IngestOptions } from './common';
import { readFileSync } from 'node:fs';

export const WB_INDICATORS = { gdp_pct: 'MS.MIL.XPND.GD.ZS', usd: 'MS.MIL.XPND.CD', gdp: 'NY.GDP.MKTP.CD' } as const;
export const WB_SOURCE = { id: 'worldbank_wdi', title: 'World Bank World Development Indicators (SIPRI 기반 국방비·GDP)', url: 'https://data.worldbank.org/indicator/MS.MIL.XPND.GD.ZS', confidence: 1 };
export const wbUrl = (indicator: string, from: number, to: number, page = 1) => `https://api.worldbank.org/v2/country/all/indicator/${indicator}?format=json&per_page=20000&date=${from}:${to}&page=${page}`;

interface WbPoint { countryiso3code: string; date: string; value: number | null; country: { value: string } }
/** [메타, 값 목록] 형식. 지역 합계(ISO3가 비었거나 집계 코드)는 국가 ID가 아니라 이후 단계에서 걸러진다 */
export function wbPoints(body: unknown): WbPoint[] {
  if (!Array.isArray(body) || body.length < 2) { const msg = (body as any)?.[0]?.message?.[0]?.value; throw new Error(`World Bank 응답 형식 오류${msg ? `: ${msg}` : ''}`); }
  return (body[1] || []) as WbPoint[];
}
/** World Bank 집계 코드(지역·소득 그룹) — 국가가 아니다 */
const AGGREGATES = new Set('AFE AFW ARB CEB CSS EAP EAR EAS ECA ECS EMU EUU FCS HIC HPC IBD IBT IDA IDB IDX INX LAC LCN LDC LIC LMC LMY LTE MEA MIC MNA NAC OED OSS PRE PSS PST SAS SSA SSF SST TEA TEC TLA TMN TSA TSS UMC WLD'.split(' '));

export function normalizeWorldBank(series: { gdp_pct: WbPoint[]; usd: WbPoint[]; gdp: WbPoint[] }) {
  const rows = new Map<string, Partial<BudgetRow>>(), known = countryIndex().ids;
  const put = (p: WbPoint, f: (r: Partial<BudgetRow>) => void) => {
    const id = p.countryiso3code === 'XKX' ? 'KOS' : p.countryiso3code;
    if (!id || AGGREGATES.has(id) || !known.has(id) || p.value == null) return; // 지역·소득 그룹 합계 제외
    const key = `${id}:${p.date}`; if (!rows.has(key)) rows.set(key, { country: id, year: Number(p.date) });
    f(rows.get(key)!);
  };
  for (const p of series.gdp_pct) put(p, r => { r.gdp_pct = Math.round(p.value! * 100) / 100; });
  for (const p of series.usd) put(p, r => { r.usd_m = Math.round(p.value! / 1e5) / 10; });
  for (const p of series.gdp) put(p, r => { r.gdp_usd_m = Math.round(p.value! / 1e5) / 10; });
  return [...rows.values()];
}

export async function ingestWorldBank(opts: IngestOptions = {}) {
  const to = collectionYear(opts), from = Number(opts.args?.since) || to - 15;
  let series: { gdp_pct: WbPoint[]; usd: WbPoint[]; gdp: WbPoint[] };
  if (opts.file) series = JSON.parse(readFileSync(opts.file, 'utf8'));
  else {
    const get = async (indicator: string) => {
      const all: WbPoint[] = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        await opts.progress?.(`World Bank ${indicator} ${page}/${pages}쪽`);
        const body = JSON.parse(text(new Uint8Array(await (await fetchRetry(opts.fetch || fetch, wbUrl(indicator, from, to, page), {}, { timeoutMs: 90000, signal: opts.signal })).arrayBuffer())));
        pages = body?.[0]?.pages || 1; all.push(...wbPoints(body));
      }
      return all;
    };
    series = { gdp_pct: await get(WB_INDICATORS.gdp_pct), usd: await get(WB_INDICATORS.usd), gdp: await get(WB_INDICATORS.gdp) };
  }
  const rows = normalizeWorldBank(series);
  return load(opts, WB_SOURCE, { budgets: rows }, [`${from}~${to}년, 지표 ${Object.values(WB_INDICATORS).join(', ')}`], { budgets: ['usd_m', 'gdp_pct', 'yoy_pct', 'source_id', 'confidence'] });
}
