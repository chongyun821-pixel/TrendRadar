export interface WeaponTooltipEntry {
  id: string; name: string; nameKo: string; aliases: string[]; systemKo: string; typeKo: string;
  maker: string | null; originKo: string; operatorsKo: string[]; introYear: number | null; description: string;
}
export function buildWeaponMatcher(entries: WeaponTooltipEntry[]) {
  const byTerm = new Map<string, WeaponTooltipEntry>();
  for (const entry of entries) for (const raw of [entry.name, entry.nameKo, ...entry.aliases]) {
    const term = raw.trim();
    if (term.length < 2 || /^\d+$/.test(term)) continue;
    if (!byTerm.has(term.toLocaleLowerCase())) byTerm.set(term.toLocaleLowerCase(), entry);
  }
  return [...byTerm].map(([term, entry]) => ({ term, entry })).sort((a, b) => b.term.length - a.term.length);
}
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
let entriesPromise: Promise<WeaponTooltipEntry[]> | undefined, tooltip: HTMLElement | undefined, hideTimer: number | undefined;
const decorationGeneration = new WeakMap<HTMLElement, number>();
function loadEntries() {
  if (!entriesPromise) entriesPromise = fetch('/api/weapons').then(r => r.ok ? r.json() : []).catch(() => []);
  return entriesPromise;
}
function getTip() {
  if (tooltip) return tooltip;
  tooltip = document.createElement('div'); tooltip.className = 'weapon-tooltip'; tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip'); document.body.append(tooltip);
  // 카드 위로 커서를 옮겨 긴 설명을 스크롤할 수 있게 카드 안에서는 닫지 않는다
  tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tooltip.addEventListener('mouseleave', hideSoon);
  window.addEventListener('scroll', hide, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  return tooltip;
}
function show(span: HTMLElement, entry: WeaponTooltipEntry) {
  const tip = getTip(); clearTimeout(hideTimer);
  tip.innerHTML = `<strong>${esc(entry.nameKo)}${entry.name !== entry.nameKo ? ` <small>${esc(entry.name)}</small>` : ''}</strong><dl><dt>종류</dt><dd>${esc(entry.typeKo)} (${esc(entry.systemKo)})</dd>${entry.maker ? `<dt>제작사</dt><dd>${esc(entry.maker)}</dd>` : ''}<dt>기원</dt><dd>${esc(entry.originKo)}</dd>${entry.introYear != null ? `<dt>도입 연도</dt><dd>${entry.introYear}</dd>` : ''}<dt>설명</dt><dd>${esc(entry.description)}</dd><dt>운용 국가</dt><dd>${esc(entry.operatorsKo.join(', '))}</dd></dl>`;
  tip.hidden = false;
  const r = span.getBoundingClientRect(), b = tip.getBoundingClientRect();
  tip.style.left = `${Math.max(8, Math.min(innerWidth - b.width - 8, r.left))}px`;
  // 아래 공간이 부족하면 용어 위에 띄워 카드가 용어를 가리지 않게 한다
  const below = r.bottom + 7, above = r.top - b.height - 7;
  const top = below + b.height <= innerHeight - 8 || above < 8 ? below : above;
  tip.style.top = `${Math.max(8, Math.min(innerHeight - b.height - 8, top))}px`;
}
function hide() { clearTimeout(hideTimer); if (tooltip) tooltip.hidden = true; }
function hideSoon() { clearTimeout(hideTimer); hideTimer = window.setTimeout(hide, 150); }
export async function decorateWeaponTerms(root: HTMLElement) {
  const generation = (decorationGeneration.get(root) ?? 0) + 1; decorationGeneration.set(root, generation);
  const entries = await loadEntries(); if (!entries.length || !root.isConnected || decorationGeneration.get(root) !== generation) return;
  const matcher = buildWeaponMatcher(entries);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest('a,button,code,pre,input,textarea,select,.weapon-term')) return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  } });
  const nodes: Text[] = []; while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const boundary = (s: string, i: number, n: number) => (!/[A-Za-z0-9]/.test(s[n - 1] || '') || !/[A-Za-z0-9]/.test(s[n] || '')) && (!/[A-Za-z0-9]/.test(s[i] || '') || !/[A-Za-z0-9]/.test(s[i - 1] || ''));
  for (const node of nodes) {
    const text = node.data, lower = text.toLocaleLowerCase(); let cursor = 0, changed = false;
    const fragment = document.createDocumentFragment();
    while (cursor < text.length) {
      let best: { start: number; end: number; entry: WeaponTooltipEntry } | undefined;
      for (const { term, entry } of matcher) {
        let at = lower.indexOf(term, cursor);
        while (at >= 0 && !boundary(text, at, at + term.length)) at = lower.indexOf(term, at + 1);
        if (at < 0) continue;
        if (!best || at < best.start || (at === best.start && term.length > best.end - best.start)) best = { start: at, end: at + term.length, entry };
      }
      if (!best) { fragment.append(text.slice(cursor)); break; }
      if (best.start > cursor) fragment.append(text.slice(cursor, best.start));
      const span = document.createElement('span'); span.className = 'weapon-term'; span.dataset.weaponId = best.entry.id; span.tabIndex = 0; span.textContent = text.slice(best.start, best.end);
      span.addEventListener('mouseenter', () => show(span, best!.entry)); span.addEventListener('focus', () => show(span, best!.entry));
      span.addEventListener('mouseleave', hideSoon); span.addEventListener('blur', hide);
      fragment.append(span); cursor = best.end; changed = true;
    }
    if (changed) node.replaceWith(fragment);
  }
}
