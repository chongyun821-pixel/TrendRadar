import { reportDocSchema, type Block, type ReportDoc } from '../shared/report-doc';
import { reportFilename, reportToHtml } from '../shared/report-export';
import { formatKrw } from '../shared/forecast';

type Patch = { type: 'replace'; blockId: string; block: Block } | { type: 'remove'; blockId: string } | { type: 'insert'; index: number; block: Block };
type Plot = (typeof import('plotly.js-basic-dist-min'))['default'];
let plotPromise: Promise<Plot> | null = null;
const loadPlot = () => plotPromise ??= import('plotly.js-basic-dist-min').then(m => m.default);
const copy = <T>(value: T): T => structuredClone(value);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const roundedMoneyInput = (value: number) => Math.abs(value) >= 10_000 ? Math.round(value / 1000) * 1000 : Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
const defaultBlock = (type: string): Block => {
  const id = crypto.randomUUID();
  switch (type) {
    case 'heading': return { id, type, level: 2, text: '새 제목' };
    case 'list': return { id, type, ordered: false, items: ['새 항목'] };
    case 'table': return { id, type, columns: ['항목', '내용'], rows: [['', '']] };
    case 'chart': return { id, type, chartType: 'bar', title: '새 그래프', categories: ['항목 1', '항목 2'], series: [{ name: '계열 1', values: [1, 2] }] };
    case 'insight': return { id, type, items: [] };
    case 'note': return { id, type, text: '메모를 입력하세요.' };
    case 'pagebreak': return { id, type };
    default: return { id, type: 'paragraph', html: '새 문단을 입력하세요.' };
  }
};

export interface ReportEditorApi {
  open(doc: ReportDoc): void;
  getDoc(): ReportDoc | null;
  applyPatch(ops: Patch[]): void;
  select(blockId: string): void;
  export(format: 'html' | 'pdf' | 'docx'): Promise<void>;
}

export function initReportEditor() {
  const overlay = document.createElement('section'); overlay.id = 'reportEditor'; overlay.className = 'report-editor'; overlay.hidden = true;
  overlay.innerHTML = `<header class="re-top"><div class="re-brand"><b>보고서 편집기</b><span class="re-notice" aria-live="polite"></span></div><nav><button data-action="undo" type="button" title="실행 취소">실행 취소</button><button data-action="redo" type="button" title="다시 실행">다시 실행</button><button data-action="restore" type="button">원본으로 되돌리기</button><div class="re-menu-wrap"><button data-action="export-menu" type="button">내보내기 ▾</button><div class="re-export-menu" hidden><button data-export="html">HTML 파일</button><button data-export="pdf">PDF 파일</button><button data-export="docx">Word 파일</button></div></div><button data-action="close" type="button">닫기</button></nav></header><main class="re-workspace"><section class="re-canvas-wrap"><article class="re-paper"></article></section><aside id="reportAiPanel"><b>AI 도구</b><p>AI 도구는 곧 연결됩니다</p></aside></main>`;
  document.body.append(overlay);
  const paper = overlay.querySelector<HTMLElement>('.re-paper')!, notice = overlay.querySelector<HTMLElement>('.re-notice')!;
  let doc: ReportDoc | null = null, original: ReportDoc | null = null, undo: ReportDoc[] = [], redo: ReportDoc[] = [], selected = '', restored = false, renderLock = false, chartsReady: Promise<void> = Promise.resolve();
  const snapshot = () => { if (doc && !renderLock) { undo.push(copy(doc)); if (undo.length > 100) undo.shift(); redo = []; save(); } };
  const save = () => { if (doc) try { localStorage.setItem(`report-draft:${doc.id}`, JSON.stringify(doc)); } catch { /* 저장 제한 */ } };
  function render() {
    if (!doc) return;
    renderLock = true;
    paper.innerHTML = `<div class="re-cover"><div class="re-title" contenteditable="true" data-doc-title>${esc(doc.title)}</div>${doc.subtitle ? `<div class="re-subtitle" contenteditable="true" data-doc-subtitle>${esc(doc.subtitle)}</div>` : ''}<div class="re-meta">${esc(doc.basisDate ?? '')} <span>${doc.source.kind === 'ranking' ? '조달 사업 예상' : '국가 분석'}</span></div></div>` + doc.blocks.map(blockHtml).join('') + `<button class="re-add-last" data-add="paragraph" type="button">＋ 블록 추가</button>`;
    renderLock = false;
    chartsReady = mountCharts();
  }
  function blockHtml(block: Block): string {
    let content = '';
    switch (block.type) {
      case 'heading': content = `<h${block.level} contenteditable="true" data-field="text">${esc(block.text)}</h${block.level}>`; break;
      case 'paragraph': content = `<div class="re-editable" contenteditable="true" data-field="html">${block.html}</div>`; break;
      case 'list': content = `<${block.ordered ? 'ol' : 'ul'}>${block.items.map((x, i) => `<li contenteditable="true" data-item="${i}">${x}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`; break;
      case 'table': content = `<div class="re-table-tools"><button data-table="row+">행 추가</button><button data-table="row-">행 삭제</button><button data-table="col+">열 추가</button><button data-table="col-">열 삭제</button></div><table><thead><tr>${block.columns.map((x, i) => `<th contenteditable="true" data-column="${i}">${esc(x)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row, r) => `<tr>${block.columns.map((_, c) => `<td contenteditable="true" data-cell="${r}:${c}">${esc(row[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`; break;
      case 'chart': content = `<h3 contenteditable="true" data-chart-title>${esc(block.title)}</h3><div class="re-chart" data-chart="${block.id}"></div><div class="re-chart-controls"><label>유형 <select data-chart-type><option value="bar" ${block.chartType === 'bar' ? 'selected' : ''}>막대</option><option value="stacked-bar" ${block.chartType === 'stacked-bar' ? 'selected' : ''}>누적 막대</option><option value="line" ${block.chartType === 'line' ? 'selected' : ''}>선</option><option value="pie" ${block.chartType === 'pie' ? 'selected' : ''}>원형</option></select></label><button data-chart-row="add">범주 추가</button>${block.unit ? '<small class="re-chart-unit">금액 단위는 억이며, 입력값은 억 단위입니다.</small>' : ''}<div class="re-grid-scroll"><div class="re-grid" style="--series-count:${block.series.length}"><strong>범주</strong>${block.series.map(s => `<strong>${esc(s.name)}</strong>`).join('')}${block.categories.map((x, i) => `<label><input aria-label="범주 ${i + 1}" data-category="${i}" value="${esc(x)}"></label>${block.series.map((s, j) => `<label><input aria-label="${esc(s.name)} ${i + 1} 값" data-value="${j}:${i}" type="number" value="${block.unit ? roundedMoneyInput(s.values[i] ?? 0) : s.values[i] ?? 0}"></label>`).join('')}`).join('')}</div></div></div>`; break;
      case 'insight': content = `<aside class="re-insight"><strong>핵심 인사이트</strong>${block.items.map((x, i) => `<p contenteditable="true" data-item="${i}">${esc(x)}</p>`).join('')}<button data-insight-add>＋ 의견 추가</button></aside>`; break;
      case 'note': content = `<aside class="re-note" contenteditable="true" data-field="text">${esc(block.text)}</aside>`; break;
      case 'pagebreak': content = '<div class="re-pagebreak">페이지 나누기</div>'; break;
    }
    return `<section class="re-block${selected === block.id ? ' selected' : ''}" data-block="${block.id}"><div class="re-toolbar"><button data-move="-1" title="위로">↑</button><button data-move="1" title="아래로">↓</button><button data-duplicate title="복제">복제</button><button data-delete title="삭제">삭제</button><select data-insert-after aria-label="블록 추가"><option value="">＋ 블록 추가</option>${[['heading','제목'],['paragraph','문단'],['list','목록'],['table','표'],['chart','그래프'],['insight','인사이트'],['note','메모'],['pagebreak','페이지 나누기']].map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>${content}</section>`;
  }
  async function mountChart(Plotly: Plot, node: HTMLElement, block: Extract<Block, { type: 'chart' }>) {
    const traces = block.chartType === 'pie' ? [{ type: 'pie', labels: block.categories, values: block.series[0]?.values ?? [], name: block.series[0]?.name, marker: { colors: block.colors }, ...(block.unit ? { text: (block.series[0]?.values ?? []).map(formatKrw), hovertemplate: '%{label}<br>%{percent:.1%}<br>%{text}<extra></extra>' } : {}) }] : block.series.map((s, i) => ({ type: block.chartType === 'line' ? 'scatter' : 'bar', ...(block.chartType === 'line' ? { mode: 'lines+markers' } : {}), name: s.name, x: block.categories, y: s.values, ...(block.unit ? { text: s.values.map(formatKrw), hovertemplate: '%{x}<br>%{data.name}: %{text}<extra></extra>' } : {}), ...(block.colors?.[i] ? { marker: { color: block.colors[i] }, line: { color: block.colors[i] } } : {}), ...(block.chartType === 'stacked-bar' ? { offsetgroup: 'stack' } : {}) }));
    const maxValue = block.chartType === 'stacked-bar' ? Math.max(0, ...block.categories.map((_, index) => block.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0))) : Math.max(0, ...block.series.flatMap(s => s.values));
    const tickvals = block.unit && maxValue ? Array.from({ length: 6 }, (_, i) => maxValue * i / 5) : undefined;
    await Plotly.newPlot(node, traces as any, { barmode: block.chartType === 'stacked-bar' ? 'stack' : 'group', paper_bgcolor: '#fff', plot_bgcolor: '#fff', font: { family: 'Malgun Gothic, sans-serif', color: '#263246' }, xaxis: { title: block.xLabel }, yaxis: { title: block.yLabel, ...(tickvals ? { tickvals, ticktext: tickvals.map(formatKrw), hoverformat: ',.0f' } : {}) }, margin: { l: 70, r: 18, t: 24, b: 48 }, height: 340 }, { responsive: true, displaylogo: false });
  }
  async function mountCharts() {
    const targets = Array.from(paper.querySelectorAll<HTMLElement>('[data-chart]')); if (!targets.length) return;
    const Plotly = await loadPlot();
    for (const node of targets) {
      const block = doc?.blocks.find((b): b is Extract<Block, {type:'chart'}> => b.id === node.dataset.chart && b.type === 'chart'); if (!block) continue;
      await mountChart(Plotly, node, block);
    }
  }
  function change(mutator: () => void) { snapshot(); mutator(); doc = reportDocSchema.parse(doc); render(); }
  function applyPatch(ops: Patch[]) { change(() => { for (const op of ops) { if (op.type === 'replace') { const i = doc!.blocks.findIndex(b => b.id === op.blockId); if (i >= 0) doc!.blocks[i] = op.block; } else if (op.type === 'remove') doc!.blocks = doc!.blocks.filter(b => b.id !== op.blockId); else doc!.blocks.splice(Math.max(0, Math.min(doc!.blocks.length, op.index)), 0, op.block); } }); }
  function open(next: ReportDoc) {
    doc = reportDocSchema.parse(copy(next)); original = copy(doc); undo = []; redo = []; selected = ''; restored = false;
    try { const draft = localStorage.getItem(`report-draft:${doc.id}`); if (draft) { const parsed = reportDocSchema.safeParse(JSON.parse(draft)); if (parsed.success) { doc = parsed.data; restored = true; } } } catch { /* 오래되거나 손상된 초안 */ }
    overlay.hidden = false; document.body.classList.add('re-locked'); notice.textContent = restored ? '초안 복원됨' : ''; render();
  }
  async function exportDoc(format: 'html'|'pdf'|'docx') {
    if (!doc) return;
    await chartsReady;
    const Plotly: any = await loadPlot(); const svgs: Record<string,string> = {};
    for (const block of doc.blocks) if (block.type === 'chart') {
      const node = paper.querySelector<HTMLElement>(`[data-chart="${CSS.escape(block.id)}"]`);
      if (node?.classList.contains('js-plotly-plot')) svgs[block.id] = await Plotly.toImage(node, { format: 'svg', width: 1000, height: 600 }) as string;
      else {
        const temp = document.createElement('div'); Object.assign(temp.style, { position: 'fixed', left: '0', top: '0', width: '1000px', height: '600px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' }); document.body.append(temp);
        try { await mountChart(Plotly, temp, block); svgs[block.id] = await Plotly.toImage(temp, { format: 'svg', width: 1000, height: 600 }) as string; } finally { Plotly.purge(temp); temp.remove(); }
      }
    }
    if (format === 'html') { const blob = new Blob([reportToHtml(doc, svgs)], { type: 'text/html;charset=utf-8' }); download(blob, 'html'); return; }
    if (format === 'pdf') { const response = await fetch('/api/report-export/pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: reportToHtml(doc, svgs) }) }); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'PDF를 만들지 못했습니다.'); download(await response.blob(), 'pdf'); return; }
    await exportDocx();
  }
  function download(blob: Blob, ext: string) { const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = reportFilename(doc!.title, doc!.basisDate, ext); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000); }
  async function exportDocx() {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType } = await import('docx');
    const today = new Date();
    const writtenDate = `작성일 ${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일`;
    const children: any[] = [new Paragraph({ text: doc!.title, heading: HeadingLevel.TITLE }), ...(doc!.subtitle ? [new Paragraph(doc!.subtitle)] : []), ...(doc!.basisDate ? [new Paragraph(`기준 연도 ${doc!.basisDate}`)] : []), new Paragraph(writtenDate)];
    const exportBlocks = [...doc!.blocks];
    const isEmptyTrailingBlock = (block: Block | undefined) => !block || block.type === 'pagebreak' || block.type === 'paragraph' && !block.html.replace(/<[^>]*>/g, '').trim() || block.type === 'note' && !block.text.trim() || (block.type === 'list' || block.type === 'insight') && block.items.every(item => !item.replace(/<[^>]*>/g, '').trim());
    while (isEmptyTrailingBlock(exportBlocks.at(-1))) exportBlocks.pop();
    for (const block of exportBlocks) {
      if (block.type === 'heading') children.push(new Paragraph({ text: block.text, heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }));
      else if (block.type === 'paragraph') children.push(new Paragraph({ children: inlineRuns(block.html, TextRun) }));
      else if (block.type === 'list') block.items.forEach((text, index) => children.push(new Paragraph({ text: `${block.ordered ? `${index + 1}.` : '•'} ${text.replace(/<[^>]+>/g, '')}` })));
      else if (block.type === 'table') children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ children: block.columns.map(text => new TableCell({ shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'DCE6F2' }, children: [new Paragraph({ children: [new TextRun({ text, bold: true, font: '맑은 고딕' })] })] })) }), ...block.rows.map(row => new TableRow({ children: block.columns.map((_,i) => new TableCell({ children: [new Paragraph(String(row[i] ?? ''))] })) }))] }));
      else if (block.type === 'insight' && block.items.length) children.push(new Paragraph({ shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EAF3FF' }, children: [new TextRun({ text: block.items.join('\n'), font: '맑은 고딕' })] }));
      else if (block.type === 'note') children.push(new Paragraph({ text: block.text, shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F2F4F7' } }));
      else if (block.type === 'pagebreak') children.push(new Paragraph({ pageBreakBefore: true, text: '' }));
      else if (block.type === 'chart') { const Plotly: any = await loadPlot(); const node = paper.querySelector<HTMLElement>(`[data-chart="${CSS.escape(block.id)}"]`); if (node?.classList.contains('js-plotly-plot')) { const data = await Plotly.toImage(node, { format: 'png', width: 1200, height: 720, scale: 2 }) as string; const bytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0)); const { ImageRun } = await import('docx'); children.push(new Paragraph({ text: block.title }), new Paragraph({ children: [new ImageRun({ data: bytes, type: 'png', transformation: { width: 600, height: 360 } })] })); } }
    }
    const blob = await Packer.toBlob(new Document({ styles: { default: { document: { run: { font: '맑은 고딕' } } } }, sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1247, bottom: 1134, left: 1020, right: 1020 } } }, children }] })); download(blob, 'docx');
  }
  function inlineRuns(html: string, TextRun: any) {
    let bold = false, italics = false, underline = false;
    return html.replace(/<br\s*\/?>/g, '\n').split(/(<\/?(?:b|i|u)>)/g).filter(Boolean).flatMap(x => {
      const tag = /^<(\/)?(b|i|u)>$/.exec(x);
      if (tag) { const active = !tag[1]; if (tag[2] === 'b') bold = active; if (tag[2] === 'i') italics = active; if (tag[2] === 'u') underline = active; return []; }
      return [new TextRun({ text: x.replace(/<[^>]+>/g, ''), bold, italics, underline, font: '맑은 고딕' })];
    });
  }

  overlay.addEventListener('input', event => {
    if (!doc) return; const target = event.target as HTMLElement, block = target.closest<HTMLElement>('[data-block]'), b = doc.blocks.find(x => x.id === block?.dataset.block); if (!b) { if (target.matches('[data-doc-title]')) doc.title = target.innerText; else if (target.matches('[data-doc-subtitle]')) doc.subtitle = target.innerText; doc = reportDocSchema.parse(doc); save(); return; }
    if (target.dataset.field && (b.type === 'heading' || b.type === 'paragraph' || b.type === 'note')) (b as any)[target.dataset.field] = target.dataset.field === 'html' ? target.innerHTML : target.innerText;
    if (target.dataset.item && (b.type === 'list' || b.type === 'insight')) b.items[Number(target.dataset.item)] = target.innerText;
    if (target.dataset.column && b.type === 'table') b.columns[Number(target.dataset.column)] = target.innerText;
    if (target.dataset.cell && b.type === 'table') { const [r,c] = target.dataset.cell.split(':').map(Number); b.rows[r][c] = target.innerText; }
    if (target.dataset.category && b.type === 'chart') b.categories[Number(target.dataset.category)] = (target as HTMLInputElement).value;
    if (target.dataset.value && b.type === 'chart') { const [s,i] = target.dataset.value.split(':').map(Number); b.series[s].values[i] = Number((target as HTMLInputElement).value); }
    if (target.dataset.series && b.type === 'chart') b.series[Number(target.dataset.series)].name = (target as HTMLInputElement).value;
    if (target.dataset.chartTitle && b.type === 'chart') b.title = target.innerText;
    if (!renderLock) { doc = reportDocSchema.parse(doc); save(); }
  });
  overlay.addEventListener('beforeinput', () => { if (doc && !renderLock) snapshot(); });
  overlay.addEventListener('change', event => { const target = event.target as HTMLElement, block = target.closest<HTMLElement>('[data-block]'), b = doc?.blocks.find(x => x.id === block?.dataset.block); if (!b) return;
    if (target.matches('[data-chart-type]') && b.type === 'chart') { change(() => { b.chartType = (target as HTMLSelectElement).value as any; }); return; }
    if (target.matches('[data-insert-after]')) { const type = (target as HTMLSelectElement).value; if (type) { const index = doc!.blocks.findIndex(x => x.id === b.id); change(() => doc!.blocks.splice(index + 1, 0, defaultBlock(type))); } return; }
    if (target.matches('[data-category],[data-value],[data-series]')) render(); else save();
  });
  overlay.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button,[data-action]'); if (!target) return; const section = target.closest<HTMLElement>('[data-block]'), b = doc?.blocks.find(x => x.id === section?.dataset.block);
    if (target.dataset.action === 'close') { overlay.hidden = true; document.body.classList.remove('re-locked'); return; }
    if (target.dataset.action === 'undo') { if (doc && undo.length) { redo.push(copy(doc)); doc = undo.pop()!; render(); } return; }
    if (target.dataset.action === 'redo') { if (doc && redo.length) { undo.push(copy(doc)); doc = redo.pop()!; render(); } return; }
    if (target.dataset.action === 'export-menu') { overlay.querySelector<HTMLElement>('.re-export-menu')!.hidden = !overlay.querySelector<HTMLElement>('.re-export-menu')!.hidden; return; }
    if (target.dataset.action === 'restore' && original && doc) { try { localStorage.removeItem(`report-draft:${doc.id}`); } catch { /* 저장 제한 */ } undo = []; redo = []; doc = copy(original); restored = false; notice.textContent = '원본으로 되돌렸습니다'; render(); return; }
    if (target.dataset.export) { void exportDoc(target.dataset.export as any).catch(error => { notice.textContent = error.message; }); overlay.querySelector<HTMLElement>('.re-export-menu')!.hidden = true; return; }
    if (target.dataset.restore && doc) { try { localStorage.removeItem(`report-draft:${doc.id}`); } catch {} notice.textContent = '원본으로 되돌렸습니다. 다시 열면 원본을 불러옵니다.'; return; }
    if (target.dataset.add) { change(() => doc!.blocks.push(defaultBlock(target.dataset.add!))); return; }
    if (target.dataset.delete && b) { change(() => doc!.blocks = doc!.blocks.filter(x => x.id !== b.id)); return; }
    if (target.dataset.duplicate && b) { const i = doc!.blocks.findIndex(x => x.id === b.id), next = copy(b); next.id = crypto.randomUUID(); change(() => doc!.blocks.splice(i + 1, 0, next)); return; }
    if (target.dataset.move && b) { const i = doc!.blocks.findIndex(x => x.id === b.id), j = i + Number(target.dataset.move); if (j >= 0 && j < doc!.blocks.length) change(() => [doc!.blocks[i], doc!.blocks[j]] = [doc!.blocks[j], doc!.blocks[i]]); return; }
    if (target.dataset.table && b?.type === 'table') change(() => { const action = target.dataset.table; if (action === 'row+') b.rows.push(b.columns.map(() => '')); else if (action === 'row-') b.rows.pop(); else if (action === 'col+') { b.columns.push(`열 ${b.columns.length + 1}`); b.rows.forEach(row => row.push('')); } else if (action === 'col-' && b.columns.length > 1) { b.columns.pop(); b.rows.forEach(row => row.pop()); } });
    if (target.hasAttribute('data-insight-add') && b?.type === 'insight') change(() => b.items.push('새 의견을 입력하세요.'));
    if (target.dataset.chartRow && b?.type === 'chart') change(() => { b.categories.push(`항목 ${b.categories.length + 1}`); b.series.forEach(s => s.values.push(0)); });
    if (b) { selected = b.id; paper.querySelectorAll('.re-block').forEach(x => x.classList.toggle('selected', x.getAttribute('data-block') === selected)); }
  });
  document.addEventListener('keydown', event => { if (overlay.hidden || event.isComposing || !(event.ctrlKey || event.metaKey)) return; if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.stopImmediatePropagation(); if (event.shiftKey) overlay.querySelector<HTMLButtonElement>('[data-action=redo]')!.click(); else overlay.querySelector<HTMLButtonElement>('[data-action=undo]')!.click(); } else if (event.key.toLowerCase() === 'y') { event.preventDefault(); event.stopImmediatePropagation(); overlay.querySelector<HTMLButtonElement>('[data-action=redo]')!.click(); } }, true);
  document.addEventListener('keydown', event => { if (!overlay.hidden && event.key === 'Escape') { const menu = overlay.querySelector<HTMLElement>('.re-export-menu')!; if (!menu.hidden) { menu.hidden = true; event.preventDefault(); event.stopImmediatePropagation(); } else { overlay.querySelector<HTMLButtonElement>('[data-action=close]')!.click(); event.preventDefault(); event.stopImmediatePropagation(); } } }, true);
  addEventListener('radar:open-report-editor', event => { const value = (event as CustomEvent<ReportDoc>).detail; if (value) open(value); });
  addEventListener('radar:close-report-editor', () => { if (!overlay.hidden) overlay.querySelector<HTMLButtonElement>('[data-action=close]')!.click(); });
  const api: ReportEditorApi = { open, getDoc: () => doc ? copy(doc) : null, applyPatch, select: blockId => { selected = blockId; render(); }, export: exportDoc };
  (window as any).reportEditor = api;
  return api;
}
