import { reportDocSchema, sanitizeInline, type Block, type ReportDoc } from './report-doc';
import { svgMarkup } from './report-export';
import { formatKrw, fmtKrwRange } from './forecast';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
const color = (value: string | undefined, index: number) => /^#[0-9a-f]{6}$/i.test(value ?? '') ? value! : ['#f37221', '#18b5a6', '#d84a98', '#36afe4', '#e4ad00', '#7654c3'][index % 6];
const chartBlocks = (blocks: Block[]) => blocks.filter((block): block is Extract<Block, { type: 'chart' }> => block.type === 'chart');
const tableBlocks = (blocks: Block[]) => blocks.filter((block): block is Extract<Block, { type: 'table' }> => block.type === 'table');
const heading = (text: string, blockId?: string) => `<h2${blockId ? ` data-block="${esc(blockId)}" data-field="text"` : ''}>${esc(text)}</h2>`;
const panel = (title: string, body: string, note = '', headingId?: string) => `<section class="panel"><div class="panel-head"><h3${headingId ? ` data-block="${esc(headingId)}" data-field="text"` : ''}>${esc(title)}</h3><small>${esc(note)}</small></div>${body}</section>`;
const table = (block: Extract<Block, { type: 'table' }>, rows = block.rows, rowOffset = 0) => `<table data-block="${esc(block.id)}"><thead><tr>${block.columns.map((column, index) => `<th data-column="${index}">${esc(column === '예상 수주액 범위' ? '예상 수주액 범위(*2)' : column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, rowIndex) => `<tr>${block.columns.map((_, index) => `<td data-cell="${rowOffset + rowIndex}:${index}">${esc(row[index] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

function summaryTrend(block: Extract<Block, { type: 'chart' }>): string {
  const years = block.categories.slice(0, 3);
  const totals = years.map((_, index) => block.series.reduce((sum, series) => sum + Math.max(0, series.values[index] ?? 0), 0));
  const sliced = { ...block, categories: years, series: block.series.map(series => ({ ...series, values: series.values.slice(0, 3) })) };
  const chart = block.chartType === 'bar' ? compactChart(sliced) : timeline(sliced);
  return `<div class="summary-trend" aria-label="3년 연도별 예상 수주액 추이">${chart}<div class="summary-year-amounts">${years.map((year, index) => `<div><span>${esc(year)}년 합계</span><b>${esc(formatKrw(totals[index]))} 원</b></div>`).join('')}</div></div>`;
}

function countryTotals(block: Extract<Block, { type: 'table' }> | undefined) {
  const totals = new Map<string, [number, number]>();
  for (const row of block?.rows ?? []) {
    const range = /^\s*([\d,.]+)(조|억)\s*~\s*([\d,.]+)(조|억)\s*원\s*$/.exec(String(row[2]));
    if (!range) continue;
    const low = Number(range[1].replaceAll(',', '')) * (range[2] === '조' ? 10000 : 1);
    const high = Number(range[3].replaceAll(',', '')) * (range[4] === '조' ? 10000 : 1);
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    const name = String(row[0]), total = totals.get(name) ?? [0, 0];
    totals.set(name, [total[0] + low, total[1] + high]);
  }
  return [...totals].sort((a, b) => b[1][0] + b[1][1] - a[1][0] - a[1][1]).slice(0, 2);
}

function donut(block: Extract<Block, { type: 'chart' }>): string {
  const values = block.series[0]?.values ?? [];
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0);
  let start = -Math.PI / 2;
  const paths = values.map((value, index) => {
    const span = total ? Math.max(0, value) / total * Math.PI * 2 : 0;
    if (!span) return '';
    const end = start + Math.min(span, Math.PI * 2 - 0.00001);
    const xy = (angle: number) => `${(110 + 92 * Math.cos(angle)).toFixed(2)} ${(110 + 92 * Math.sin(angle)).toFixed(2)}`;
    const path = `<path d="M110 110 L${xy(start)} A92 92 0 ${span > Math.PI ? 1 : 0} 1 ${xy(end)} Z" fill="${color(block.colors?.[index], index)}"/>`;
    start += span;
    return path;
  }).join('');
  const legend = block.categories.map((name, index) => `<div class="legend-item"><i style="background:${color(block.colors?.[index], index)}"></i><span>${esc(name)}</span><b>${total ? (Math.max(0, values[index] ?? 0) / total * 100).toFixed(1) : '0.0'}%</b></div>`).join('');
  return `<div class="mix-visual" data-block="${esc(block.id)}"><svg viewBox="0 0 220 220" role="img" aria-label="${esc(block.title)}">${paths}<circle cx="110" cy="110" r="50" fill="white"/><text x="110" y="100" text-anchor="middle" class="donut-label">3년 합계</text><text x="110" y="123" text-anchor="middle" class="donut-total">${Math.round(total).toLocaleString('ko-KR')}억</text></svg><div class="mix-legend">${legend}</div></div>`;
}

function compactChart(block: Extract<Block, { type: 'chart' }>): string {
  const categories = block.categories;
  const series = block.series;
  const max = Math.max(1, ...series.flatMap(line => line.values)) * 1.1;
  const left = 45, top = 12, width = 625, height = 147;
  const x = (index: number) => left + width * (index + .5) / Math.max(1, categories.length);
  const y = (value: number) => top + height * (1 - Math.max(0, value) / max);
  const grid = [0, 1, 2, 3].map(index => {
    const value = max * index / 3;
    return `<line x1="${left}" y1="${y(value)}" x2="${left + width}" y2="${y(value)}" stroke="#d8e0e8"/><text x="${left - 6}" y="${y(value) + 3}" text-anchor="end" class="axis">${Math.round(value).toLocaleString('ko-KR')}</text>`;
  }).join('');
  const ticks = categories.map((category, index) => index % Math.max(1, Math.ceil(categories.length / 8)) === 0 ? `<text x="${x(index)}" y="${top + height + 17}" text-anchor="middle" class="axis">${esc(category)}</text>` : '').join('');
  const marks = series.map((line, seriesIndex) => {
    if (block.chartType === 'line') return `<polyline fill="none" stroke="${color(block.colors?.[seriesIndex], seriesIndex)}" stroke-width="2.4" points="${line.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}"/>`;
    const slot = width / Math.max(1, categories.length);
    const barWidth = slot * .75 / Math.max(1, series.length);
    return line.values.map((value, index) => `<rect x="${x(index) - slot * .375 + seriesIndex * barWidth}" y="${y(value)}" width="${barWidth}" height="${top + height - y(value)}" fill="${color(block.colors?.[seriesIndex], seriesIndex)}"/>`).join('');
  }).join('');
  const legend = series.map((line, index) => `<span><i style="background:${color(block.colors?.[index], index)}"></i>${esc(line.name)}</span>`).join('');
  return `<div class="alt-chart" data-block="${esc(block.id)}"><svg viewBox="0 0 700 185" role="img" aria-label="${esc(block.title)}">${grid}${ticks}${marks}</svg><div class="timeline-legend">${legend}</div></div>`;
}

function timeline(block: Extract<Block, { type: 'chart' }>): string {
  const years = block.categories;
  const series = block.series;
  if (!years.length || !series.length) return '<p>그래프 자료가 없습니다.</p>';
  const left = 52, top = 12, width = 635, height = 240;
  const max = Math.max(1, ...series.flatMap(line => line.values)) * 1.1;
  const x = (index: number) => left + width * index / Math.max(1, years.length - 1);
  const y = (value: number) => top + height * (1 - Math.max(0, value) / max);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const value = max * index / 4;
    const ordinate = y(value);
    return `<line x1="${left}" y1="${ordinate}" x2="${left + width}" y2="${ordinate}" stroke="#d8e0e8"/><text x="${left - 7}" y="${ordinate + 3}" text-anchor="end" class="axis">${Math.round(value).toLocaleString('ko-KR')}</text>`;
  }).join('');
  const ticks = years.map((year, index) => years.length <= 3 || index % 2 === 0 || index === years.length - 1 ? `<text x="${x(index)}" y="${top + height + 19}" text-anchor="middle" class="axis">${esc(year)}</text>` : '').join('');
  const lines = series.map((line, index) => `<polyline fill="none" stroke="${color(block.colors?.[index], index)}" stroke-width="2.4" points="${line.values.map((value, year) => `${x(year).toFixed(2)},${y(value).toFixed(2)}`).join(' ')}"/>`).join('');
  const legend = series.map((line, index) => `<span><i style="background:${color(block.colors?.[index], index)}"></i>${esc(line.name)}</span>`).join('');
  return `<div class="timeline" data-block="${esc(block.id)}"><svg viewBox="0 0 710 284" role="img" aria-label="${esc(block.title)}">${grid}${ticks}${lines}</svg><div class="timeline-legend">${legend}</div></div>`;
}

function extraBlock(block: Block, svgs: Record<string, string>): string {
  switch (block.type) {
    case 'heading': return `<h3 data-block="${esc(block.id)}" data-field="text">${esc(block.text)}</h3>`;
    case 'paragraph': return `<p data-block="${esc(block.id)}" data-field="html">${sanitizeInline(block.html)}</p>`;
    case 'table': return table(block);
    case 'chart': return `<figure data-block="${esc(block.id)}"><figcaption>${esc(block.title)}</figcaption>${svgMarkup(svgs[block.id] ?? '') || '<p>그래프 이미지를 포함하지 못했습니다.</p>'}</figure>`;
    case 'list': return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map(item => `<li>${sanitizeInline(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
    case 'insight': return `<aside>${block.items.map(item => `<p>${esc(item)}</p>`).join('')}</aside>`;
    case 'note': return `<aside>${esc(block.text)}</aside>`;
    case 'pagebreak': return '';
  }
}

/** Landscape PDF layout for the ranking report. Its content comes from the current editor document. */
export function reportToPresentationHtml(input: ReportDoc, svgs: Record<string, string> = {}, logoDataUri = '/hanwha-logo.jpg'): string {
  const doc = reportDocSchema.parse(input);
  const sections = new Map<string, Block[]>();
  const headings = doc.blocks.flatMap((block, index) => block.type === 'heading' && block.level === 2 ? [index] : []);
  const charts = doc.blocks.flatMap((block, index) => block.type === 'chart' ? [index] : []);
  const tables = doc.blocks.flatMap((block, index) => block.type === 'table' ? [index] : []);
  const named = (number: string) => headings.find(index => doc.blocks[index].type === 'heading' && (doc.blocks[index] as Extract<Block, { type: 'heading' }>).text.startsWith(`${number} `));
  const boundaries = [
    named('01') ?? headings[0],
    named('02') ?? headings.find(index => index > (tables[0] ?? charts[0] ?? -1) && index < (charts[1] ?? Infinity)),
    named('03') ?? headings.find(index => index > (charts[1] ?? Infinity)),
    named('04') ?? [...headings].reverse().find(index => index < (tables.at(-1) ?? -1) && index > (charts[1] ?? Infinity)),
  ];
  boundaries.forEach((start, index) => {
    if (start == null || start < 0) return;
    const end = boundaries.slice(index + 1).find(next => next != null && next > start) ?? doc.blocks.length;
    sections.set(`0${index + 1}`, doc.blocks.slice(start, end));
  });
  const slides: string[] = [];
  const used = new Set<Block>();
  const add = (title: string, body: string, subtitle = '') => {
    const source = title.endsWith('(계속)') ? undefined : doc.blocks.find(block => block.type === 'heading' && block.text === title);
    slides.push(`<article class="slide"><header>${heading(title, source?.id)}<span>${esc(subtitle)}</span></header><main>${body}</main><footer><span>HORUS / 예상 수주 전망 보고서</span><span>${slides.length + 2}</span></footer></article>`);
  };

  const mix = sections.get('01') ?? [];
  const pie = chartBlocks(mix)[0];
  const mixTable = tableBlocks(mix)[0];
  const mixSummary = mix.find((block): block is Extract<Block, { type: 'paragraph' }> => block.type === 'paragraph');
  const intro = doc.blocks.slice(0, doc.blocks.findIndex(block => block === mix[0])).filter((block): block is Extract<Block, { type: 'paragraph' }> => block.type === 'paragraph');
  const trend = sections.get('02') ?? [];
  const annual = chartBlocks(trend)[0];
  const countryTable = tableBlocks(sections.get('04') ?? [])[0];
  if (mix.length || trend.length) {
    const totals = pie?.categories.map((name, index) => ({ name, value: pie.series[0]?.values[index] ?? 0 })).sort((a, b) => b.value - a.value).slice(0, 2) ?? [];
    const systemsText = totals.length ? `무기체계별 3년 예상 수주액은 ${totals.map(item => `${item.name} ${formatKrw(item.value)}`).join(', ')} 순으로 높습니다.` : '무기체계별 예상 수주액 자료를 확인할 수 없습니다.';
    const countryAmounts = countryTotals(countryTable);
    const countriesText = countryAmounts.length ? `국가별 상위 3개 기회 중 금액이 확인된 사업의 합계는 ${countryAmounts.map(([name, amount]) => `${name} ${fmtKrwRange(amount)}`).join(', ')} 순으로 높습니다.` : '국가별 예상 수주액 자료를 확인할 수 없습니다.';
    add('Executive Summary', `<div class="summary-top"><div class="summary-mix">${panel('예상 수주 매출 구성비', pie ? pie.chartType === 'pie' ? donut(pie) : compactChart(pie) : '<p>그래프 자료가 없습니다.</p>', '3년 예상 수주액, 단위: 억원')}</div><div class="summary-annual">${panel('연도별 예상 수주액 추이', annual ? summaryTrend(annual) : '<p>그래프 자료가 없습니다.</p>', '향후 3년, 단위: 억원')}</div></div><div class="summary-bottom"><h3>주요 수주 기회</h3><p>${esc(systemsText)}</p><p>${esc(countriesText)}</p></div>`);
  }
  if (mix.length) {
    [mix[0], pie, mixTable, mixSummary, ...intro].forEach(block => { if (block) used.add(block); });
    add((mix[0] as Extract<Block, { type: 'heading' }>).text,
      `<div class="mix-top">${panel('무기체계별 구성', pie ? pie.chartType === 'pie' ? donut(pie) : compactChart(pie) : '<p>그래프 자료가 없습니다.</p>', '단위: 억원')}</div><div class="mix-table">${panel('합계 및 범위(*1)', mixTable ? table(mixTable, mixTable.rows.slice(0, 6)) : '<p>표 자료가 없습니다.</p>', '예상 수주액')}</div><p class="footnote">(*1) 3년 합계, 무기체계별 상위 5개국 기준입니다.<br>(*2) ${[...intro, ...(mixSummary ? [mixSummary] : [])].map(block => `<span data-block="${esc(block.id)}" data-field="html">${sanitizeInline(block.html)}</span>`).join(' ')} 금액은 예측 범위의 중간값 기준이며 실제 매출 인식액과 다를 수 있습니다.</p>`);
    if (mixTable) for (let index = 6; index < mixTable.rows.length; index += 9) add(`${(mix[0] as Extract<Block, { type: 'heading' }>).text} (계속)`, panel('예상 수주액 범위', table(mixTable, mixTable.rows.slice(index, index + 9), index)), '무기체계별 구성');
  }

  if (trend.length) {
    [trend[0], annual].forEach(block => { if (block) used.add(block); });
    add((trend[0] as Extract<Block, { type: 'heading' }>).text,
      `${panel(annual?.title ?? '연간 예상 수주액', annual ? annual.chartType === 'pie' ? donut(annual) : annual.chartType === 'bar' ? compactChart(annual) : timeline(annual) : '<p>그래프 자료가 없습니다.</p>', '단위: 억원')}<p class="footnote">무기별 임박 TOP 5를 고정하고 예상 금액 중간값을 사업 기간에 균등 배분했습니다. 선택된 사업의 기간 밖 연도는 0원이며, 전체 시장의 수요가 없다는 의미는 아닙니다.</p>`,
      annual?.categories.length ? `${annual.categories[0]}–${annual.categories.at(-1)}년` : '');
  }

  const systems = sections.get('03') ?? [];
  if (systems.length) {
    const entries: { title: string; body: string; headingId?: string }[] = [];
    let title = '', headingId = '';
    for (const block of systems.slice(1)) {
      if (block.type === 'heading') { title = block.text; headingId = block.id; used.add(block); }
      if (block.type === 'table') {
        used.add(block);
        for (let index = 0; index < Math.max(1, Math.ceil(block.rows.length / 5)); index++) {
          entries.push({ title: `${title}${index ? ` (${index + 1})` : ''}`, headingId: index ? undefined : headingId, body: table(block, block.rows.slice(index * 5, index * 5 + 5), index * 5) });
        }
      }
    }
    used.add(systems[0]);
    for (let index = 0; index < entries.length; index += 2) add((systems[0] as Extract<Block, { type: 'heading' }>).text,
      entries.slice(index, index + 2).map(entry => panel(entry.title, entry.body, '', entry.headingId)).join(''), '예상 시기 도래 순 / 체계별 TOP 5');
  }

  const countries = sections.get('04') ?? [];
  if (countries.length) {
    const countrySectionTable = tableBlocks(countries)[0];
    used.add(countries[0]);
    if (countrySectionTable) used.add(countrySectionTable);
    if (countrySectionTable) for (let index = 0; index < Math.max(1, Math.ceil(countrySectionTable.rows.length / 9)); index++) {
      add((countries[0] as Extract<Block, { type: 'heading' }>).text,
        panel('국가별 수주 기회', table(countrySectionTable, countrySectionTable.rows.slice(index * 9, index * 9 + 9), index * 9), '금액은 예상 범위'), '국가별 TOP 3 / 예상 시기 도래 순');
    }
  }

  const extra = doc.blocks.filter(block => !used.has(block) && block.type !== 'pagebreak' && !(block.type === 'insight' && !block.items.length));
  for (let index = 0; index < extra.length; index += 2) add('추가 내용', extra.slice(index, index + 2).map(block => extraBlock(block, svgs)).join(''));
  const date = new Date();
  const written = `${date.getFullYear()}. ${String(date.getMonth() + 1).padStart(2, '0')}. ${String(date.getDate()).padStart(2, '0')}`;
  const cover = `<article class="slide cover"><img class="cover-logo" src="${esc(logoDataUri)}" alt="Hanwha"><div class="cover-brand"><strong>HORUS</strong><span>Hanwha Observation &amp; Reconnaissance Unified System</span></div><div class="cover-title"><div class="accent"></div><h1 data-doc-title>${esc(doc.title)}</h1><h2>${esc(doc.basisDate ?? '')} 기준  |  무기체계별 전망</h2></div><div class="cover-meta"><div><span data-doc-subtitle>${esc(doc.subtitle ?? '')}</span>, 작성일 ${written}</div></div></article>`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
@page{size:780pt 540pt;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;color:#333a42;font-family:"Malgun Gothic","맑은 고딕",sans-serif}body{background:white}.slide{position:relative;width:780pt;height:540pt;padding:34pt 39pt 30pt;break-after:page;overflow:hidden}.slide:last-child{break-after:auto}.slide header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:4pt solid #f37221;position:relative;margin-bottom:24pt;padding-bottom:14pt}.slide header:after{content:"";position:absolute;bottom:-4pt;left:0;width:123pt;height:4pt;background:#204d79}h2{margin:0;color:#204d79;font-size:20pt;line-height:1.15}.slide header span{font-size:8pt;color:#526171;padding-top:5pt}.slide main{height:402pt}.panel{min-width:0}.panel-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:.8pt solid #204d79;padding:0 2pt 9pt;margin-bottom:14pt}.panel h3{font-size:13pt;line-height:1.2;margin:0;color:#204d79}.panel small{font-size:8pt;color:#526171}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8.5pt}th{background:#204d79;color:white;font-weight:700;height:29pt}td{text-align:center;padding:6pt 4pt;height:28pt;border-bottom:.5pt solid #d4dde5;overflow-wrap:anywhere}tbody tr:nth-child(odd){background:#f2f5f8}td:nth-child(3){color:#204d79;font-weight:700}.mix-visual{display:flex;align-items:center;gap:35pt;height:150pt}.mix-visual svg{width:150pt;height:150pt}.donut-label{font-size:11px;fill:#526171}.donut-total{font-size:15px;font-weight:700;fill:#204d79}.mix-legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20pt;min-width:0;flex:1}.legend-item{display:grid;grid-template-columns:9pt 1fr auto;align-items:center;gap:5pt;font-size:8.5pt;margin:7pt 0}.legend-item i,.timeline-legend i{display:inline-block;width:8pt;height:8pt}.legend-item span{overflow-wrap:anywhere}.mix-top .panel-head{margin-bottom:5pt}.mix-table .panel-head{margin-bottom:8pt;padding-bottom:6pt}.mix-table th{height:25pt}.mix-table td{height:22pt;padding:3pt}.mix-table .panel h3{font-size:12pt}.mix-table{margin-top:2pt}.mix-table+.footnote{margin-top:8pt}.footnote{font-size:8pt;color:#526171;margin-top:18pt}.timeline svg{width:100%;height:275pt}.axis{fill:#526171;font-size:8px}.timeline-legend{display:grid;grid-template-columns:repeat(3,1fr);gap:9pt;margin-left:52pt;font-size:8.5pt}.timeline-legend span{display:flex;gap:7pt;align-items:center}.timeline-legend i{height:3pt;width:25pt}.slide:has(.panel + .panel) .panel{margin-bottom:15pt}.slide:has(.panel + .panel) .panel table{margin-top:2pt}.slide:has(.panel + .panel) .panel th{height:26pt}.slide:has(.panel + .panel) .panel td{height:26pt}.slide:has(.panel + .panel) .panel-head{margin-bottom:7pt;padding-bottom:5pt}.slide:has(.panel + .panel) .panel h3{font-size:12pt}.slide:not(:has(.panel + .panel)) main>.panel table td{height:37pt}.slide footer{position:absolute;left:39pt;right:39pt;bottom:10pt;border-top:.5pt solid #d4dde5;padding-top:6pt;display:flex;justify-content:space-between;color:#526171;font-size:8pt}.cover{padding:0}.cover-brand{position:absolute;left:42pt;top:213pt;font-size:20pt;font-weight:700}.cover-title{position:absolute;left:95pt;top:265pt}.cover-title .accent{position:absolute;left:-95pt;top:5pt;width:80pt;height:24pt;background:#f37221}.cover-title h1{margin:0;color:#f37221;font-size:28pt}.cover-title h2{margin-top:10pt;color:#333a42;font-size:21pt}.cover-meta{position:absolute;left:95pt;right:39pt;bottom:80pt;border-top:1pt solid #f37221;padding-top:11pt;color:#526171;font-size:10pt}.cover-meta div+div{margin-top:8pt}figure svg{max-width:100%;max-height:310pt}figure{margin:10pt 0}aside{background:#f2f5f8;padding:10pt}p{font-size:10pt;line-height:1.5}
</style><style>.alt-chart svg{display:block;width:100%;height:240pt}.mix-top .alt-chart svg{height:150pt}.alt-chart .timeline-legend{margin:0;display:flex;flex-wrap:wrap;gap:7pt 16pt}.alt-chart .timeline-legend span{font-size:8pt}.mix-top .alt-chart .timeline-legend{max-height:20pt;overflow:hidden}.cover-logo{position:absolute;right:39pt;top:28pt;width:163pt;height:auto}.cover-brand{left:95pt;top:207pt}.cover-brand strong{display:block;font-size:20pt}.cover-brand span{display:block;margin-top:5pt;font-size:9pt;font-weight:400;color:#526171}.cover-meta{text-align:right}.summary-top{display:grid;grid-template-columns:1fr 1fr;gap:22pt}.summary-top .panel-head{margin-bottom:12pt}.summary-top .panel h3{font-size:12pt}.summary-top .panel small{font-size:7pt}.summary-mix .mix-visual{height:165pt;gap:8pt}.summary-mix .mix-visual svg{width:120pt;height:120pt;flex:none}.summary-mix .mix-legend{display:block}.summary-mix .legend-item{font-size:7pt;margin:4pt 0}.summary-trend svg{display:block;width:100%;height:140pt}.summary-trend .timeline-legend{display:grid;grid-template-columns:repeat(3,1fr);gap:4pt;margin:1pt 0 7pt 22pt;font-size:6pt}.summary-trend .timeline-legend span{gap:4pt}.summary-trend .timeline-legend i{width:10pt;height:2pt}.summary-trend .axis{font-size:14px}.summary-year-amounts{display:grid;grid-template-columns:repeat(3,1fr);gap:6pt;margin-top:5pt}.summary-year-amounts div{text-align:center;padding:6pt 2pt;background:#f2f5f8}.summary-year-amounts span{display:block;color:#526171;font-size:7pt}.summary-year-amounts b{display:block;margin-top:3pt;color:#204d79;font-size:10pt}.summary-bottom{margin-top:24pt;padding:16pt 18pt;border-top:1.5pt solid #204d79;background:#f2f5f8}.summary-bottom h3{margin:0 0 11pt;color:#204d79;font-size:13pt}.summary-bottom p{margin:8pt 0;font-size:10pt;line-height:1.5}.mix-table+.footnote{line-height:1.45}</style></head><body>${cover}${slides.join('')}</body></html>`;
}
