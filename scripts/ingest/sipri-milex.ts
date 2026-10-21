/**
 * SIPRI 국방비 DB(XLSX) → budgets. 금액은 당해 US$ 백만, 증가율은 불변(2024년) US$ 기준 실질 증가율, GDP 비율은 %.
 * 인증키 불필요. 파일 이름에 판 번호가 들어가므로 --url로 바꿀 수 있다.
 * 사용: npm run ingest:sipri-milex -- [--dry-run] [--since 2010] [--file 받은.xlsx] [--url ...]
 */
import type { BudgetRow } from '../../shared/types';
import { baseYear, countryId, isMain, load, readInput, runCli, type IngestOptions } from './common';
import { readXlsx } from './xlsx';

export const SIPRI_MILEX_URL = 'https://www.sipri.org/sites/default/files/SIPRI-Milex-data-1949-2025_v1.2.xlsx';
export const SIPRI_MILEX_SOURCE = { id: 'sipri_milex', title: 'SIPRI Military Expenditure Database', url: 'https://www.sipri.org/databases/milex', confidence: 1 };

type Sheet = (string | number | null)[][];
/** 'Country' 머리글 행을 찾아 국가 → 연도 → 값 표로 바꾼다. 숫자가 아닌 칸('...', 'xxx')은 결측 */
export function sheetSeries(sheet: Sheet | undefined): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  if (!sheet) return out;
  const head = sheet.findIndex(r => r?.[0] === 'Country');
  if (head < 0) return out;
  const years = sheet[head].map(v => (typeof v === 'number' && v > 1900 ? v : null));
  for (const row of sheet.slice(head + 1)) {
    const name = row?.[0]; if (typeof name !== 'string') continue;
    const series = new Map<number, number>();
    row.forEach((v, i) => { if (years[i] && typeof v === 'number' && Number.isFinite(v)) series.set(years[i]!, v); });
    if (series.size) out.set(name, series);
  }
  return out;
}

export function normalizeMilex(workbook: Record<string, Sheet>, since: number) {
  const current = sheetSeries(workbook['Current US$']), constant = sheetSeries(workbook[Object.keys(workbook).find(n => /^Constant/.test(n)) || '']), share = sheetSeries(workbook['Share of GDP']);
  const rows: Partial<BudgetRow>[] = [], unknown: string[] = [];
  for (const [name, series] of current) {
    const country = countryId(name);
    if (!country) { unknown.push(name); continue; }
    for (const [year, usd] of series) {
      if (year < since) continue;
      const c = constant.get(name), prev = c?.get(year - 1), now = c?.get(year);
      const gdp = share.get(name)?.get(year);
      rows.push({ country, year, usd_m: Math.round(usd * 10) / 10, yoy_pct: prev && now != null ? Math.round((now / prev - 1) * 1000) / 10 : null, gdp_pct: gdp == null ? null : Math.round(gdp * 10000) / 100 });
    }
  }
  return { rows, unknown };
}

export async function ingestSipriMilex(opts: IngestOptions = {}) {
  const since = Number(opts.args?.since) || baseYear(opts) - 15;
  const url = typeof opts.args?.url === 'string' ? opts.args.url : SIPRI_MILEX_URL;
  const workbook = readXlsx(await readInput(opts, url));
  if (!workbook['Current US$']) throw new Error(`SIPRI 국방비 파일에 'Current US$' 시트가 없습니다(시트: ${Object.keys(workbook).join(', ')})`);
  const { rows, unknown } = normalizeMilex(workbook, since);
  const notes = [`${since}년 이후`, `원본 파일 ${url}`, ...(unknown.length ? [`국가 ID 미매칭: ${unknown.join(', ')}`] : [])];
  return load(opts, { ...SIPRI_MILEX_SOURCE, url }, { budgets: rows }, notes, { budgets: ['gdp_usd_m'] });
}

if (isMain(import.meta.url)) await runCli('sipri-milex', ingestSipriMilex);
