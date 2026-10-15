/** 아주 작은 마크다운 렌더러 (제목, 목록, 굵게, 기울임, 링크, 코드, 구분선) */
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
function inline(s: string) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>').replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, a, u) => `<a href="${u}" target="_blank" rel="noopener">${a}</a>`);
  return t;
}
export function md(src: string): string {
  const out: string[] = []; let list = false;
  for (const raw of src.split(/\r?\n/)) {
    const l = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(l) || /^\s*\d+\.\s+(.*)$/.exec(l);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^---+$/.test(l)) { out.push('<hr>'); continue; }
    if (!l.trim()) continue;
    out.push(`<p>${inline(l)}</p>`);
  }
  if (list) out.push('</ul>');
  return out.join('');
}
export { esc };
