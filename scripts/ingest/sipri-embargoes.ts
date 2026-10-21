/**
 * SIPRI 무기 금수 DB(UN 의무·비의무, EU, 기타 다자) → export_controls. 인증키 불필요.
 * 비국가 대상(괄호 안 무장단체 등) 금수는 국가 전체가 아니므로 status='partial'로 둔다.
 * 사용: npm run ingest:sipri-embargoes -- [--dry-run] [--file 저장한.html]
 */
import type { ExportControlRow } from '../../shared/types';
import { countryId, isMain, load, readInput, runCli, text, type IngestOptions } from './common';
import { htmlTables } from './html';

export const SIPRI_EMBARGO_URL = 'https://www.sipri.org/databases/embargoes';
export const SIPRI_EMBARGO_SOURCE = { id: 'sipri_embargoes', title: 'SIPRI Arms Embargoes Database', url: SIPRI_EMBARGO_URL, confidence: 1 };
const REGIME_BY_CAPTION: [RegExp, string][] = [[/^mandatory un/i, 'UN'], [/^non.mandatory un/i, 'OTHER'], [/^eu/i, 'EU'], [/other multilateral/i, 'OTHER']];
/** 괄호 안이 나라 전체가 아닌 대상(무장단체·비정부군)을 뜻하는지 */
const NON_STATE = /non-governmental|ngf|taliban|unita|rebel|forces|militia|al-qaida|isil|houthi|rsf|janjaweed|hezbollah|isis|\bfactions?\b|ecowas|states\)/i;
/** 법적 구속력 없는 EU 정치 선언(국내 진압용 장비 등 한정). 국가 전체 금수가 아니라 status='partial'로 두어 2세계 승인 항목으로 남긴다 */
export const NON_BINDING = new Set(['EU:EGY', 'EU:CHN']);
const isoDate = (s: string) => { const d = new Date(`${s.trim()} UTC`); return s.trim() && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null; };

export function parseEmbargoes(html: string) {
  const rows: Partial<ExportControlRow>[] = [], unknown: string[] = [];
  for (const table of htmlTables(html)) {
    const regime = REGIME_BY_CAPTION.find(([re]) => re.test(table.caption))?.[1];
    if (!regime) continue;
    for (const r of table.rows.slice(1)) {
      const [target, entry, suspended, lifted] = r.cells;
      if (!target) continue;
      const country = countryId(target.replace(/\(.*\)/, '').trim());
      if (!country) { unknown.push(target); continue; }
      const href = /href="([^"]+)"/.exec(r.html[0])?.[1];
      const started = /datetime="(\d{4}-\d{2}-\d{2})/.exec(r.html[1] || '')?.[1] || isoDate(entry || '');
      const paren = /\(([^)]*)\)/.exec(target)?.[1] || '';
      const status: ExportControlRow['status'] = lifted ? 'lifted' : suspended ? 'suspended' : (paren && NON_STATE.test(`(${paren})`)) || NON_BINDING.has(`${regime}:${country}`) ? 'partial' : 'active';
      const slug = (href || target).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase().slice(-80);
      rows.push({ id: `sipri:${regime}:${slug}`, country, regime, name: `${table.caption}: ${target}`, status, started, ended: lifted ? isoDate(lifted) : suspended ? isoDate(suspended) : null, url: href ? new URL(href, SIPRI_EMBARGO_URL).href : SIPRI_EMBARGO_URL });
    }
  }
  return { rows, unknown };
}

export async function ingestSipriEmbargoes(opts: IngestOptions = {}) {
  const { rows, unknown } = parseEmbargoes(text(await readInput(opts, SIPRI_EMBARGO_URL)));
  if (!rows.length) throw new Error('SIPRI 금수 표를 찾지 못했습니다(페이지 구조 변경 확인 필요)');
  return load(opts, SIPRI_EMBARGO_SOURCE, { export_controls: rows }, unknown.length ? [`국가 ID 미매칭: ${unknown.join(', ')}`] : []);
}

if (isMain(import.meta.url)) await runCli('sipri-embargoes', ingestSipriEmbargoes);
