import { describe, expect, it } from 'vitest';
import { seed } from '../shared/data';
import { markdownToDoc, rankingToDoc, reportDocSchema } from '../shared/report-doc';
import { reportFilename, reportToHtml } from '../shared/report-export';

describe('report document model', () => {
  it('converts markdown headings, inline formatting, lists, tables, and quotes', () => {
    const doc = markdownToDoc('# 분석\n\n굵은 **문장**과 [링크](https://example.com).\n\n- 하나\n- 둘\n\n| 항목 | 값 |\n|---|---|\n| 국가 | 폴란드 |\n\n> 확인할 내용', '시험 보고서');
    expect(doc.blocks.map(b => b.type)).toEqual(['heading', 'paragraph', 'list', 'table', 'note', 'insight']);
    expect(doc.blocks[1]).toMatchObject({ type: 'paragraph', html: expect.stringContaining('<b>문장</b>') });
    expect(reportDocSchema.parse(doc).source.kind).toBe('country');
  });

  it('rejects duplicate ids and unsafe markup', () => {
    const doc = markdownToDoc('본문');
    const duplicate = { ...doc, blocks: [doc.blocks[0], { ...doc.blocks[0] }] };
    expect(reportDocSchema.safeParse(duplicate).success).toBe(false);
    expect(reportDocSchema.parse({ ...doc, blocks: [{ id: 'p', type: 'paragraph', html: '<script>alert(1)</script><b onclick="x">안전</b>' }] }).blocks[0]).toMatchObject({ html: '<b>안전</b>' });
  });

  it('converts the ranking report with an editable chart data block and tables', () => {
    const doc = rankingToDoc(seed);
    expect(doc.source.kind).toBe('ranking');
    expect(doc.title).toBe('예상 수주 전망 보고서');
    expect(doc.blocks.some(b => b.type === 'chart' && b.colors?.length)).toBe(true);
    expect(doc.blocks.some(b => b.type === 'chart' && b.categories.length > 0)).toBe(true);
    expect(doc.blocks.some(b => b.type === 'table' && b.rows.length > 0)).toBe(true);
  });
});

describe('report export html', () => {
  it('writes real tables, chart SVG, document metadata, and safe filenames', () => {
    const doc = markdownToDoc('## 표\n\n| 이름 | 수량 |\n|---|---|\n| 장비 | 2 |');
    doc.basisDate = '2026년';
    doc.blocks.push({ id: 'chart', type: 'chart', chartType: 'line', title: '추세', categories: ['2026'], series: [{ name: '예상', values: [3] }] });
    const html = reportToHtml(doc, { chart: '<svg viewBox="0 0 2 2"><path d="M0 0"/></svg>' });
    expect(html).toContain('<table>'); expect(html).toContain('<svg'); expect(html).toContain('2026년');
    const today = new Date();
    const date = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    expect(reportFilename('문서: / 확인?', '2026년', 'pdf')).toBe(`문서_확인_${date}.pdf`);
  });

  it('embeds an SVG passed in the chart map, including a Plotly SVG data URL', () => {
    const doc = markdownToDoc('본문');
    doc.blocks.push({ id: 'svg-chart', type: 'chart', chartType: 'bar', title: '차트', categories: ['A'], series: [{ name: '계열', values: [1] }] });
    const svg = encodeURIComponent('<svg viewBox="0 0 2 2"><path d="M0 0"/></svg>');
    const html = reportToHtml(doc, { 'svg-chart': `data:image/svg+xml,${svg}` });
    expect(html).toContain('<svg viewBox="0 0 2 2">');
    expect(html).not.toContain('그래프 이미지를 포함하지 못했습니다.');
  });
});
