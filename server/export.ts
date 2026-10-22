import MarkdownIt from 'markdown-it';
import { chromium, type Browser } from 'playwright-core';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, Header, Footer, PageNumber, AlignmentType, BorderStyle, SectionType } from 'docx';
import { PAGE_DEFS, type Report } from '../shared/types';
import { config } from './config';
import { AppError } from './store';
export const md = new MarkdownIt({ html: false, linkify: true, breaks: true });
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function pageContent(page: Report['pages'][number]) {
  if (!page.content.trim()) return '<p class="empty">아직 작성하지 않은 산출물입니다.</p>';
  if (page.id === 'problem') {
    const chunks = page.content.split(/^##\s+/m);
    if (chunks.length >= 7) return `<div class="definition-intro">${md.render(chunks.shift()!)}</div><div class="definition-grid">${chunks.map(chunk => {
      const line = chunk.indexOf('\n');
      const heading = line < 0 ? chunk : chunk.slice(0, line), body = line < 0 ? '' : chunk.slice(line + 1);
      return `<section class="definition-row"><h2>${esc(heading)}</h2><div>${md.render(body)}</div></section>`;
    }).join('')}</div>`;
  }
  return md.render(page.content);
}
export function reportHtml(report: Report) {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.title)}</title><style>
  @page{size:A4;margin:0}*{box-sizing:border-box}body{margin:0;background:#e7e9ee;color:#172135;font:11pt/1.65 'Malgun Gothic','맑은 고딕','Apple SD Gothic Neo',sans-serif}.screen{position:sticky;top:0;padding:14px 25px;background:#101722;color:white;display:flex;justify-content:space-between;z-index:3}.screen button{border:1px solid #4c6381;background:transparent;color:white;padding:8px 15px;border-radius:6px;cursor:pointer}.page{width:210mm;height:297mm;background:white;margin:24px auto;page-break-after:always;padding:18mm 20mm 19mm;position:relative;display:flex;flex-direction:column;box-shadow:0 5px 30px #0001}.page:last-child{page-break-after:auto}.meta{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #dce1e9;padding-bottom:12px;font-size:8pt;letter-spacing:1.1px;color:#6b7280}.brand{font-size:12pt;font-weight:800;color:#101722}.brand span{color:#487bdd}.eyebrow{font-size:8pt;color:#6481a8;margin-top:8mm;letter-spacing:1px}h1{font-size:23pt;line-height:1.3;margin:3mm 0 6mm;letter-spacing:-1px;color:#111827}.body{flex:1;min-height:0;font-size:11pt;overflow:visible}.body h1{font-size:16pt}.body h2{font-size:12pt;margin:5mm 0 2mm;color:#203955}.body h3{font-size:10.5pt;margin:3mm 0 1mm;color:#34445d}.body p{margin:0 0 2mm}.body ul,.body ol{padding-left:5mm;margin:2mm 0}.body li{margin:1mm 0}.body blockquote{margin:3mm 0;padding:3mm 5mm;border-left:3px solid #5084e5;background:#f1f5fb}.body table{width:100%;border-collapse:collapse;margin:4mm 0;font-size:9pt;table-layout:fixed;word-break:break-word}.body th{background:#e9eff7;text-align:left}.body th,.body td{border:1px solid #d8dfe9;padding:2.4mm;vertical-align:top}.body a{color:#305d9c;overflow-wrap:anywhere}.body code{white-space:pre-wrap;word-break:break-word}.body pre{white-space:pre-wrap;background:#f5f6f8;padding:3mm}.empty{color:#929baa;margin-top:15mm}.foot{flex-shrink:0;border-top:1px solid #dce1e9;padding-top:3mm;display:flex;justify-content:space-between;color:#7b8798;font-size:8pt}.overflow-note{position:fixed;bottom:20px;left:20px;padding:15px;background:#9c2e29;color:white;max-width:600px;z-index:5;display:none}@media print{body{background:white}.screen,.overflow-note{display:none!important}.page{margin:0;box-shadow:none}}
  .body{overflow:auto}.definition-intro{font-size:9pt;color:#607089}.definition-intro blockquote{padding:2mm 3mm;margin:0 0 3mm}.definition-intro blockquote p{margin:0}.definition-row{display:grid;grid-template-columns:28mm minmax(0,1fr);gap:4mm;border-top:1px solid #dce4ef;padding:2.3mm 0;break-inside:avoid}.definition-row>h2{font-size:10.5pt;line-height:1.55;margin:0;font-weight:700;color:#2c435f}.definition-row>div{font-size:10.5pt;line-height:1.5}.definition-row p{margin:0 0 1mm}.definition-row h3{font-size:10pt;margin:1mm 0 0;line-height:1.5}.definition-row h3:first-child{margin-top:0}.definition-row ul{padding-left:4mm;margin:0}.definition-row li{margin:0}.page[data-page="2"] .body>ul{display:flex;list-style:none;gap:4mm;padding:0}.page[data-page="2"] .body>ul>li{flex:1;min-width:0;background:#f2f6fc;border:1px solid #d7e2f1;border-top:3px solid #537fb8;padding:4mm;font-weight:600}.page[data-page="2"] .body>ul>li ul{font-weight:400;border-left:1px solid #b5c9e2;margin-left:1mm}.page[data-page="5"] .body>h2:first-child+p{padding:5mm;background:#eaf0f9;border-top:3px solid #5079b5;font-weight:600;color:#233d62}.page[data-page="5"] .body>ul{display:flex;gap:5mm;list-style:none;padding:0}.page[data-page="5"] .body>ul>li{flex:1;background:#f4f6f9;border:1px solid #d7dfe9;border-radius:2mm;padding:4mm;font-weight:600}.page[data-page="5"] .body ul ul{font-weight:400;padding-left:4mm}@media print{.body{overflow:visible}}
  </style></head><body><div class="screen"><span>H5S Studio · ${esc(report.title)} · 7페이지</span><button onclick="window.print()">인쇄 / PDF 저장</button></div>${report.pages.map((p, i) => `<section class="page" data-page="${i + 1}"><div class="meta"><span class="brand">H5S<span> STUDIO</span></span><span>${esc(report.title)} · ${p.status === 'confirmed' ? '확정' : '검토용 초안'}</span></div><div class="eyebrow">STEP 0${PAGE_DEFS[i].step + 1} / ${esc(PAGE_DEFS[i].english.toUpperCase())}</div><h1>${esc(PAGE_DEFS[i].title)}</h1><div class="body">${pageContent(p)}</div><div class="foot"><span>${new Date(report.updatedAt).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} · H5S 컨설팅 보고서</span><span>${String(i + 1).padStart(2, '0')} / 07</span></div></section>`).join('')}<div class="overflow-note"></div><script>
  window.checkLayout=()=>{const bad=[];document.querySelectorAll('.page').forEach(p=>{const b=p.querySelector('.body');if(b.scrollHeight>b.clientHeight+3)bad.push(Number(p.dataset.page));});return bad;};
  document.fonts.ready.then(()=>{const bad=window.checkLayout();if(bad.length){const n=document.querySelector('.overflow-note');n.textContent=bad.join(', ')+'페이지 내용이 한 페이지를 넘습니다. 내용을 줄인 뒤 PDF·Word로 내보내주세요. HTML에는 전체 내용이 보존됩니다.';n.style.display='block';}});
  </script></body></html>`;
}
export async function openBrowser(): Promise<Browser> {
  if (!config.chrome) throw new AppError('PDF 변환용 Chrome 또는 Edge를 찾지 못했습니다. CHROME_PATH를 설정해주세요.', 503);
  return chromium.launch({ executablePath: config.chrome, headless: true });
}
export async function validateHtmlLayout(browser: Browser, html: string) {
  const page = await browser.newPage();
  await page.emulateMedia({ media: 'print' });
  await page.setContent(html, { waitUntil: 'load' }); await page.evaluate(() => document.fonts.ready);
  const overflow: number[] = await page.evaluate(() => (window as any).checkLayout());
  if (overflow.length) { await page.close(); throw new AppError(`${overflow.join(', ')}페이지의 내용이 한 페이지 분량을 넘습니다. 내용을 줄여주세요. 원문은 보존됩니다.`, 422); }
  return page;
}
export async function exportPdf(report: Report) {
  const browser = await openBrowser();
  try { const page = await validateHtmlLayout(browser, reportHtml(report)); return await page.pdf({ printBackground: true, preferCSSPageSize: true, tagged: true }); }
  finally { await browser.close(); }
}
function inlineRuns(token: any): TextRun[] {
  let bold = false, italics = false;
  const out: TextRun[] = [];
  for (const t of token?.children || []) {
    if (t.type === 'strong_open') bold = true;
    else if (t.type === 'strong_close') bold = false;
    else if (t.type === 'em_open') italics = true;
    else if (t.type === 'em_close') italics = false;
    else if (['text', 'code_inline'].includes(t.type)) out.push(new TextRun({ text: t.content, bold, italics }));
    else if (['softbreak', 'hardbreak'].includes(t.type)) out.push(new TextRun({ text: '', break: 1 }));
    else if (t.type === 'link_close') { /* Link destinations added below by the block parser. */ }
  }
  return out;
}
function wordBlocks(content: string, compact = false): (Paragraph | Table)[] {
  const tokens = md.parse(content, {}), blocks: (Paragraph | Table)[] = [];
  let listDepth = 0, listItem = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'table_open') {
      const rows: TableRow[] = []; let cells: TableCell[] = [];
      for (i++; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
        const v = tokens[i];
        if (v.type === 'tr_open') cells = [];
        if (v.type === 'th_open' || v.type === 'td_open') {
          const inline = tokens[i + 1];
          cells.push(new TableCell({ shading: v.type === 'th_open' ? { fill: 'E9EFF7' } : undefined,
            margins: { top: 100, bottom: 100, left: 100, right: 100 },
            children: [new Paragraph({ children: inlineRuns(inline), spacing: { after: 0 }, style: 'TableText' })] }));
        }
        if (v.type === 'tr_close') rows.push(new TableRow({ children: cells, tableHeader: rows.length === 0, cantSplit: true }));
      }
      if (rows.length) blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE }, layout: 'fixed', borders: Object.fromEntries(['top', 'bottom', 'left', 'right', 'insideHorizontal', 'insideVertical'].map(k => [k, { style: BorderStyle.SINGLE, size: 3, color: 'D8DFE9' }])) }));
    } else if (t.type.endsWith('list_open')) listDepth++;
    else if (t.type.endsWith('list_close')) listDepth--;
    else if (t.type === 'list_item_open') listItem = true;
    else if (t.type === 'inline') {
      const prev = tokens[i - 1];
      const heading = prev?.type === 'heading_open' ? (Number(prev.tag.slice(1)) <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3) : undefined;
      const runs = inlineRuns(t);
      // Keep sources visible and usable in the editable Word export.
      for (const link of t.children || []) if (link.type === 'link_open') {
        const url = link.attrGet('href'); if (url) runs.push(new TextRun({ text: ` (${url})`, size: 16, color: '52657A' }));
      }
      blocks.push(new Paragraph({ children: runs, heading, ...(listItem && listDepth > 0 ? { bullet: { level: Math.min(4, listDepth - 1) } } : {}), spacing: { after: compact ? 30 : 100, before: heading ? (compact ? 40 : 150) : 0, ...(compact ? { line: 280 } : {}) }, keepNext: !!heading }));
      listItem = false;
    } else if (t.type === 'fence' || t.type === 'code_block') blocks.push(new Paragraph({ text: t.content }));
  }
  return blocks;
}
export async function exportWord(report: Report) {
  // An actual editable OOXML document, including native tables and explicit page breaks.
  const pageChildren = (p: Report['pages'][number], i: number) => {
    const children: (Paragraph | Table)[] = [new Paragraph({ text: `STEP ${PAGE_DEFS[i].step + 1}  /  ${p.status === 'confirmed' ? '확정' : '검토용 초안'}`, spacing: { after: 120 }, style: 'Caption' }), new Paragraph({ text: PAGE_DEFS[i].title, heading: HeadingLevel.TITLE, spacing: { after: 240 }, keepNext: true })];
    const chunks = p.id === 'problem' ? p.content.split(/^##\s+/m) : [];
    if (chunks.length >= 7) {
      children.push(...wordBlocks(chunks.shift()!, true));
      const rows = chunks.map(chunk => {
        const line = chunk.indexOf('\n'), heading = line < 0 ? chunk : chunk.slice(0, line), body = line < 0 ? '' : chunk.slice(line + 1);
        return new TableRow({ cantSplit: true, children: [
          new TableCell({ width: { size: 1600, type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 70, right: 100 }, children: [new Paragraph({ children: [new TextRun({ text: heading, bold: true, color: '000000', size: 21 })], spacing: { after: 0, line: 280 } })] }),
          new TableCell({ width: { size: 8038, type: WidthType.DXA }, margins: { top: 100, bottom: 100, left: 100, right: 70 }, children: wordBlocks(body, true) }),
        ] });
      });
      children.push(new Table({ width: { size: 9638, type: WidthType.DXA }, columnWidths: [1600, 8038], layout: 'fixed', borders: { top: { style: BorderStyle.SINGLE, size: 3, color: 'D8DFE9' }, bottom: { style: BorderStyle.SINGLE, size: 3, color: 'D8DFE9' }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.SINGLE, size: 3, color: 'D8DFE9' }, insideVertical: { style: BorderStyle.NONE } }, rows }));
    } else children.push(...wordBlocks(p.content || '아직 작성하지 않은 산출물입니다.'));
    return children;
  };
  const doc = new Document({ creator: 'H5S Studio', title: report.title, description: 'H5S 5단계 컨설팅 보고서',
    styles: {
      default: { document: { run: { font: '맑은 고딕', size: 21, color: '172135' }, paragraph: { spacing: { line: 310 } } }, title: { run: { font: '맑은 고딕', size: 42, bold: true, color: '000000' } }, heading2: { run: { font: '맑은 고딕', size: 23, bold: true, color: '000000' } }, heading3: { run: { font: '맑은 고딕', size: 21, bold: true, color: '000000' } } },
      paragraphStyles: [{ id: 'TableText', name: 'Table Text', basedOn: 'Normal', run: { size: 18 }, paragraph: { spacing: { line: 260, after: 0 } } }],
    }, sections: report.pages.map((p, i) => ({ properties: { type: SectionType.NEXT_PAGE, page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1134, bottom: 1000, left: 1134 } } },
      headers: { default: new Header({ children: [new Paragraph({ text: `H5S STUDIO     ${report.title}`, style: 'Caption', spacing: { after: 200 } })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'H5S 컨설팅 보고서   ', size: 16 }), new TextRun({ children: [PageNumber.CURRENT], size: 16 }), new TextRun({ text: ' / 7', size: 16 })] })] }) }, children: pageChildren(p, i) })),
  });
  return Packer.toBuffer(doc);
}
