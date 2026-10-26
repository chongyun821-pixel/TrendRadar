import MarkdownIt from 'markdown-it';
import { z } from 'zod';
import { allForecasts, formatKrw, fmtKrwRange, fmtQtyRange } from './forecast';
import type { Seed } from './types';
import { SYSTEM_KEYS } from './types';
import { SYSTEM_COLOR } from '../src/map-style';
import { countryName } from './country-name';
import { rankByWindow, revenueMix, annualRevenue } from './report-ranking';

const id = z.string().min(1).max(100);
const inline = z.string().max(100_000).transform(sanitizeInline);
const base = { id };
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('heading'), level: z.union([z.literal(1), z.literal(2), z.literal(3)]), text: z.string().max(10_000) }).strict(),
  z.object({ ...base, type: z.literal('paragraph'), html: inline }).strict(),
  z.object({ ...base, type: z.literal('list'), ordered: z.boolean(), items: z.array(z.string().max(10_000)).max(500) }).strict(),
  z.object({ ...base, type: z.literal('table'), caption: z.string().max(10_000).optional(), columns: z.array(z.string().max(1000)).min(1).max(50), rows: z.array(z.array(z.union([z.string().max(10_000), z.number().finite()])).max(50)).max(5000), align: z.array(z.enum(['left', 'center', 'right'])).optional() }).strict(),
  z.object({ ...base, type: z.literal('chart'), chartType: z.enum(['bar', 'line', 'pie', 'stacked-bar']), title: z.string().max(1000), xLabel: z.string().max(500).optional(), yLabel: z.string().max(500).optional(), unit: z.string().max(100).optional(), colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(100).optional(), series: z.array(z.object({ name: z.string().max(500), values: z.array(z.number().finite()).max(1000) }).strict()).max(100), categories: z.array(z.string().max(500)).max(1000) }).strict(),
  z.object({ ...base, type: z.literal('insight'), items: z.array(z.string().max(10_000)).max(100) }).strict(),
  z.object({ ...base, type: z.literal('note'), text: z.string().max(20_000) }).strict(),
  z.object({ ...base, type: z.literal('pagebreak') }).strict(),
]);
export type Block = z.infer<typeof blockSchema>;
export const reportDocSchema = z.object({ id, title: z.string().min(1).max(500), subtitle: z.string().max(1000).optional(), basisDate: z.string().max(100).optional(), source: z.object({ kind: z.enum(['ranking', 'country']), ref: z.string().max(500).optional() }).strict(), blocks: z.array(blockSchema).max(2000) }).strict().superRefine((doc, ctx) => {
  const ids = new Set<string>();
  doc.blocks.forEach((block, i) => { if (ids.has(block.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['blocks', i, 'id'], message: 'block id must be unique' }); ids.add(block.id); });
});
export type ReportDoc = z.infer<typeof reportDocSchema>;
const uid = () => crypto.randomUUID();
/** Keep only the small inline vocabulary supported by the editor and exports. */
export function sanitizeInline(input: string): string {
  return input.replace(/<\/?strong\b/gi, match => match.startsWith('</') ? '</b' : '<b').replace(/<\/?em\b/gi, match => match.startsWith('</') ? '</i' : '<i')
    .replace(/<(script|style|iframe|object|svg|math)[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?!\/?(?:b|i|u|a|br|span)\b)[^>]*>/gi, '')
    .replace(/<(b|i|u|br|span|a)\b([^>]*)>/gi, (_all, tag: string, attrs: string) => {
      const name = tag.toLowerCase();
      if (name === 'br') return '<br>';
      if (name === 'span') return /\bclass\s*=\s*(["'])mark\1/i.test(attrs) ? '<span class="mark">' : '<span>';
      if (name === 'a') {
        const href = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(attrs)?.[2] ?? '';
        const safe = /^(https?:|mailto:)/i.test(href) ? href.replace(/["<>]/g, '') : '';
        return safe ? `<a href="${safe}" rel="noopener noreferrer">` : '<a>';
      }
      return `<${name}>`;
    });
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
export function markdownToDoc(markdown: string, title = '국가 분석 보고서', ref?: string, sourceRef?: string): ReportDoc {
  const tokens = md.parse(markdown, {}), blocks: Block[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') { const text = tokens[++i]?.content ?? ''; blocks.push({ id: uid(), type: 'heading', level: Math.min(3, Number(t.tag[1])) as 1 | 2 | 3, text }); }
    else if (t.type === 'paragraph_open') { const token = tokens[++i]; blocks.push({ id: uid(), type: 'paragraph', html: md.renderInline(token?.content ?? '') }); }
    else if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
      const ordered = t.type === 'ordered_list_open', items: string[] = [];
      while (tokens[i + 1] && tokens[i + 1].type !== (ordered ? 'ordered_list_close' : 'bullet_list_close')) {
        if (tokens[i + 1].type === 'inline') items.push(sanitizeInline(md.renderInline(tokens[++i].content ?? '')));
        else i++;
      }
      blocks.push({ id: uid(), type: 'list', ordered, items });
    } else if (t.type === 'blockquote_open') {
      const parts: string[] = [];
      while (tokens[i + 1] && tokens[i + 1].type !== 'blockquote_close') { const next = tokens[++i]; if (next.type === 'inline') parts.push(next.content); }
      blocks.push({ id: uid(), type: 'note', text: parts.join('\n') });
    } else if (t.type === 'table_open') {
      const rows: (string | number)[][] = []; let columns: string[] = []; let row: string[] = [];
      for (i++; i < tokens.length && tokens[i].type !== 'table_close'; i++) { const token = tokens[i]; if (token.type === 'tr_open') row = []; else if (token.type === 'inline') row.push(token.content); else if (token.type === 'tr_close') { if (!columns.length) columns = row; else rows.push(row); } }
      if (columns.length) blocks.push({ id: uid(), type: 'table', columns, rows });
    }
  }
  blocks.push({ id: uid(), type: 'insight', items: [] });
  return reportDocSchema.parse({ id: ref ? `country-report:${ref}` : uid(), title, source: { kind: 'country', ...(sourceRef ? { ref: sourceRef } : {}) }, blocks });
}

export function rankingToDoc(data: Seed): ReportDoc {
  const forecasts = allForecasts(null, data), blocks: Block[] = [];
  const countries = [...new Set(forecasts.map(f => f.country))].filter(country => rankByWindow(forecasts.filter(f => f.country === country), 3).length > 0);
  const systems = SYSTEM_KEYS.filter(system => data.systems[system]?.hanwha.length);
  const pieRows = revenueMix(forecasts, data).slices.map(row => ({ ...row, value: row.midpoint }));
  const total = pieRows.reduce((sum, row) => sum + row.value, 0);
  blocks.push({ id: uid(), type: 'paragraph', html: `${data.meta.baseYear}년부터 3년간 예상 수주액 합계는 중간값 기준 ${formatKrw(total)}입니다.` });
  blocks.push({ id: uid(), type: 'heading', level: 2, text: '01 예상 수주 매출 구성비' });
  if (pieRows.length) {
    blocks.push({ id: uid(), type: 'chart', chartType: 'pie', title: '3년 합계 예상 수주액 구성', unit: '억', colors: pieRows.map(row => SYSTEM_COLOR[row.system]), categories: pieRows.map(row => data.systems[row.system].ko), series: [{ name: '예상 수주액', values: pieRows.map(row => row.value) }] });
    blocks.push({ id: uid(), type: 'table', columns: ['무기체계', '대상 국가 수', '예상 수주액 범위(*2)', '비중'], rows: pieRows.map(row => [data.systems[row.system].ko, `${row.count}개 국가`, fmtKrwRange([row.low, row.high]), `${(row.value / total * 100).toFixed(1)}%`]) });
  }
  blocks.push({ id: uid(), type: 'heading', level: 2, text: '02 연도별 예상 수주액 추이' });
  const annual = annualRevenue(forecasts, data);
  blocks.push({ id: uid(), type: 'chart', chartType: 'stacked-bar', title: '연도별 무기체계 예상 수주액', xLabel: '연도', yLabel: '예상 수주액', unit: '억', colors: annual.series.map(s => SYSTEM_COLOR[s.system]), categories: annual.years.map(String), series: annual.series.map(s => ({ name: data.systems[s.system]?.ko ?? s.system, values: s.amounts })) });
  blocks.push({ id: uid(), type: 'heading', level: 2, text: '03 무기체계별 예상 수주 국가' });
  for (const system of SYSTEM_KEYS.filter(k => data.systems[k])) {
    const rows = rankByWindow(forecasts.filter(f => f.system === system), 5);
    blocks.push({ id: uid(), type: 'heading', level: 2, text: `${data.systems[system].ko} 교체 수요 TOP 5` });
    blocks.push({ id: uid(), type: 'table', columns: ['순위', '국가', '예상 사업 금액', '예상 수량', '예상 시기'], rows: rows.map((f, i) => [i + 1, f.countryKo, fmtKrwRange(f.krw), fmtQtyRange(f.qty, f.unit), f.window ? `${f.window[0]}~${f.window[1]}년` : '미확인']) });
  }
  const countryRows = countries.map(country => ({ country, rows: rankByWindow(forecasts.filter(f => f.country === country), 3) })).filter(c => c.rows.length).sort((a, b) => b.rows.reduce((n, f) => n + (f.krw ? (f.krw[0] + f.krw[1]) / 2 : 0), 0) - a.rows.reduce((n, f) => n + (f.krw ? (f.krw[0] + f.krw[1]) / 2 : 0), 0) || countryName(a.country, data).localeCompare(countryName(b.country, data), 'ko')).slice(0, 6);
  blocks.push({ id: uid(), type: 'heading', level: 2, text: '04 국가별 예상 수주 무기' });
  blocks.push({ id: uid(), type: 'table', columns: ['국가', '무기 체계', '예상 금액', '예상 시기'], rows: countryRows.flatMap(c => c.rows.map(f => [countryName(c.country, data), f.systemKo, fmtKrwRange(f.krw), f.window ? `${f.window[0]}~${f.window[1]}년` : '미확인'])) });
  blocks.push({ id: uid(), type: 'insight', items: [] });
  return reportDocSchema.parse({ id: `ranking-report:${data.meta.baseYear}`, title: '예상 수주 전망 보고서', subtitle: `기준 연도 ${data.meta.baseYear}년, 무기체계 ${systems.length}종, 국가 ${countries.length}개`, basisDate: `${data.meta.baseYear}년`, source: { kind: 'ranking' }, blocks });
}
