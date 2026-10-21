/**
 * 미국 ITAR 22 CFR 126.1(d) 국가 목록 → export_controls. eCFR(ecfr.gov)은 자동 요청을 403/406으로 막아 Cornell LII 사본을 쓴다.
 * (d)(1) 거부 정책국은 3세계, (d)(2) 국가는 체계별 미국산 부품 여부에 따라 2·3세계로 판정한다(shared/tiers.ts).
 * CLI: npm run ingest:itar -- [--dry-run] [--file 저장한.html]
 */
import type { ExportControlRow } from '../../shared/types';
import { countryId, load, readInput, text, type IngestOptions } from './common';
import { htmlTables } from './html';

export const ITAR_URL = 'https://www.law.cornell.edu/cfr/text/22/126.1';
export const ITAR_SOURCE = { id: 'itar_126_1', title: '22 CFR § 126.1 Prohibited exports, imports, and sales to or from certain countries (Cornell LII)', url: ITAR_URL, confidence: 1 };

export function parseItar(html: string) {
  const rows: Partial<ExportControlRow>[] = [], unknown: string[] = [];
  const tables = htmlTables(html);
  for (const [n, regime] of [[1, 'US-ITAR-126.1(d)(1)'], [2, 'US-ITAR-126.1(d)(2)']] as const) {
    const table = tables.find(t => t.id === `table_number_${n}`);
    if (!table) throw new Error(`126.1 표 ${n}을 찾지 못했습니다(페이지 구조 변경 확인 필요)`);
    for (const r of table.rows.slice(1)) {
      const name = r.cells[0]; if (!name) continue;
      const country = countryId(name);
      if (!country) { unknown.push(name); continue; }
      rows.push({ id: `itar:d${n}:${country}`, country, regime, name: `ITAR 126.1(d)(${n}) ${name}${r.cells[1] ? ` — ${r.cells[1]}` : ''}`, status: n === 1 ? 'active' : 'partial', url: ITAR_URL });
    }
  }
  return { rows, unknown };
}

export async function ingestItar(opts: IngestOptions = {}) {
  const { rows, unknown } = parseItar(text(await readInput(opts, ITAR_URL)));
  return load(opts, ITAR_SOURCE, { export_controls: rows }, unknown.length ? [`국가 ID 미매칭: ${unknown.join(', ')}`] : []);
}
