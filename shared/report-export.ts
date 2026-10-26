import { reportDocSchema, sanitizeInline, type Block, type ReportDoc } from './report-doc';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export function reportFilename(title: string, basisDate?: string, extension = 'html'): string {
  const now = new Date();
  const date = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const base = title.normalize('NFKC').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, '_').slice(0, 80).replace(/[. ]+$/g, '') || '보고서';
  const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `_${base}` : base;
  return `${safe}_${date}.${extension.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}
export function svgMarkup(svg: string): string {
  const dataUrl = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(?:;base64)?,/i.exec(svg);
  if (dataUrl) {
    const payload = svg.slice(dataUrl[0].length);
    try {
      if (/;base64,/i.test(dataUrl[0])) {
        const bytes = Uint8Array.from(atob(payload), character => character.charCodeAt(0));
        svg = new TextDecoder().decode(bytes);
      } else svg = decodeURIComponent(payload);
    } catch { return ''; }
  }
  svg = svg.replace(/^\s*[\w+.-]+\s+/, '').trim();
  if (!/^\s*<svg\b/i.test(svg) || /<script|foreignObject|on\w+\s*=|(?:href|src)\s*=\s*["']?\s*(?:https?:|file:|javascript:|\/\/)/i.test(svg)) return '';
  return svg.replace(/<\/?(?:script|foreignObject)\b[^>]*>/gi, '');
}
function blockHtml(block: Block, charts: Record<string, string>): string {
  switch (block.type) {
    case 'heading': return `<h${block.level}>${esc(block.text)}</h${block.level}>`;
    case 'paragraph': return `<p>${sanitizeInline(block.html)}</p>`;
    case 'list': return `<${block.ordered ? 'ol' : 'ul'}>${block.items.map(item => `<li>${sanitizeInline(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`;
    case 'table': return `<table>${block.caption ? `<caption>${esc(block.caption)}</caption>` : ''}<thead><tr>${block.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${block.columns.map((_, i) => `<td>${esc(row[i] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'chart': return `<figure><figcaption>${esc(block.title)}</figcaption>${svgMarkup(charts[block.id] ?? '') || '<p>그래프 이미지를 포함하지 못했습니다.</p>'}</figure>`;
    case 'insight': return block.items.length ? `<aside class="insight"><ul>${block.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></aside>` : '';
    case 'note': return `<aside class="note">${esc(block.text).replace(/\n/g, '<br>')}</aside>`;
    case 'pagebreak': return '<div class="pagebreak"></div>';
  }
}
function isEmptyTrailingBlock(block: Block | undefined): boolean {
  if (!block) return false;
  if (block.type === 'pagebreak') return true;
  if (block.type === 'paragraph') return !block.html.replace(/<[^>]*>/g, '').trim();
  if (block.type === 'list' || block.type === 'insight') return block.items.every(item => !item.replace(/<[^>]*>/g, '').trim());
  if (block.type === 'note') return !block.text.trim();
  return false;
}
export function reportToHtml(input: ReportDoc, chartSvgs: Record<string, string> = {}): string {
  const doc = reportDocSchema.parse(input);
  const blocks = [...doc.blocks];
  while (isEmptyTrailingBlock(blocks.at(-1))) blocks.pop();
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(doc.title)}</title><style>
@page{size:A4;margin:22mm 18mm 20mm}*{box-sizing:border-box}body{margin:0;color:#18202c;font:11pt/1.65 "맑은 고딕","Malgun Gothic",Arial,sans-serif}.page{max-width:820px;margin:28px auto;padding:36px 48px;background:#fff}header{padding:18mm 0 14mm;border-bottom:1px solid #ccd3dc;margin-bottom:12mm}h1{font-size:25pt;line-height:1.25;margin:0 0 5mm}header p{color:#536174;margin:2mm 0}h2{font-size:18pt;margin:12mm 0 4mm;break-after:avoid}h3{font-size:14pt;margin:8mm 0 3mm;break-after:avoid}p{margin:3mm 0}table{border-collapse:collapse;width:100%;font-size:9.5pt;margin:5mm 0;break-inside:auto}thead{display:table-header-group}tr{break-inside:avoid;page-break-inside:avoid}th,td{border:1px solid #cbd3de;padding:2.5mm 3mm;text-align:left;vertical-align:top}th{background:#edf1f6;font-weight:700}caption{text-align:left;font-weight:700;margin-bottom:2mm}figure{margin:7mm 0;break-inside:avoid}figure svg{display:block;width:100%;max-height:145mm}figcaption{font-weight:700;margin-bottom:3mm}.insight{background:#edf5ff;border-left:3px solid #3975c6;padding:4mm 5mm;margin:5mm 0}.note{background:#f5f6f8;padding:4mm 5mm;border:1px solid #d8dee7;margin:5mm 0}.pagebreak{break-after:page}span.mark{background:#ffefaa;padding:0 .08em}@media print{.page{max-width:none;margin:0;padding:0}header{padding-top:0}}
</style></head><body><main class="page"><header><h1>${esc(doc.title)}</h1>${doc.subtitle ? `<p>${esc(doc.subtitle)}</p>` : ''}${doc.basisDate ? `<p>기준 연도 ${esc(doc.basisDate)}</p>` : ''}<p>${(() => { const d = new Date(); return `작성일 ${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`; })()}</p></header>${blocks.map(b => blockHtml(b, chartSvgs)).filter(Boolean).join('\n')}</main></body></html>`;
}
