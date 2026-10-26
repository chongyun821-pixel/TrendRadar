export interface WeaponTooltipEntry {
  id: string; name: string; nameKo: string; aliases: string[]; systemKo: string; typeKo: string;
  maker: string | null; originKo: string; description: string; specs: Record<string, unknown>; imageUrl: string | null;
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
  window.addEventListener('scroll', event => {
    if (event.target instanceof Node && tooltip?.contains(event.target)) return;
    hide();
  }, true);
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  return tooltip;
}
const SPEC_LABELS: Record<string, string> = {
  caliber: '\uAD6C\uACBD', rangeKm: '\uC0AC\uAC70\uB9AC', rocketsPerPod: '\uD3EC\uB4DC\uB2F9 \uB85C\uCF13', missilesPerPod: '\uD3EC\uB4DC\uB2F9 \uBBF8\uC0AC\uC77C', pods: '\uBC1C\uC0AC \uD3EC\uB4DC', tubes: '\uBC1C\uC0AC\uAD00', salvo: '\uC77C\uC81C\uC0AC\uACA9',
  missilesPerLauncher: '\uBC1C\uC0AC\uB300\uB2F9 \uBBF8\uC0AC\uC77C', missileCount: '\uBBF8\uC0AC\uC77C', crew: '\uC2B9\uBB34\uC6D0', passengers: '\uD0D1\uC2B9 \uBCD1\uB825',
  speedKmh: '\uCD5C\uACE0 \uC18D\uB3C4', speedKt: '\uCD5C\uACE0 \uC18D\uB3C4', maxSpeedKt: '\uCD5C\uACE0 \uC18D\uB3C4', weightT: '\uC911\uB7C9', weightKg: '\uC911\uB7C9',
  lengthM: '\uC804\uC7A5', widthM: '\uC804\uD3ED', heightM: '\uC804\uACE0', beamM: '\uC804\uD3ED', displacementT: '\uBC30\uC218\uB7C9',
  vlsCells: '\uC218\uC9C1\uBC1C\uC0AC\uAD00', torpedoTubes: '\uC5B4\uB8B0 \uBC1C\uC0AC\uAD00', torpedoCaliberMm: '\uC5B4\uB8B0 \uAD6C\uACBD', warheadKg: '\uD0C4\uB450 \uC911\uB7C9',
  wheels: '\uCC28\uB95C', payloadKg: '\uC801\uC7AC\uB7C9', armament: '\uC8FC\uC694 \uBB34\uC7A5', propulsion: '\uCD94\uC9C4 \uBC29\uC2DD', waterSpeedKmh: '\uC218\uC0C1 \uC18D\uB3C4',
  antiShipMissiles: '\uB300\uD568\uBBF8\uC0AC\uC77C', weaponsLoad: '\uBB34\uC7A5 \uC801\uC7AC\uB7C9',
};
const SPEC_UNITS: Record<string, string> = {
  rangeKm: 'km', speedKmh: 'km/h', speedKt: '\uB178\uD2B8', maxSpeedKt: '\uB178\uD2B8', weightT: 't', weightKg: 'kg',
  lengthM: 'm', widthM: 'm', heightM: 'm', beamM: 'm', displacementT: 't', torpedoCaliberMm: 'mm', waterSpeedKmh: 'km/h',
  warheadKg: 'kg', payloadKg: 'kg', torpedoTubes: '\uBB38', salvo: '\uBC1C',
};
const SPEC_PRIORITY = ['caliber', 'rocketsPerPod', 'missilesPerPod', 'tubes', 'salvo', 'torpedoCaliberMm', 'torpedoTubes', 'missilesPerLauncher', 'missileCount', 'vlsCells', 'rangeKm', 'crew', 'passengers', 'lengthM', 'beamM', 'widthM', 'heightM', 'displacementT', 'weightT', 'weightKg', 'speedKt', 'speedKmh', 'armament', 'propulsion'];
function weaponSpecs(specs: Record<string, unknown>) {
  return Object.entries(specs).filter(([, value]) => value != null && value !== '' && typeof value !== 'object')
    .sort(([a], [b]) => (SPEC_PRIORITY.indexOf(a) < 0 ? SPEC_PRIORITY.length : SPEC_PRIORITY.indexOf(a)) - (SPEC_PRIORITY.indexOf(b) < 0 ? SPEC_PRIORITY.length : SPEC_PRIORITY.indexOf(b)))
    .slice(0, 6).map(([key, value]) => {
      const label = SPEC_LABELS[key] || key;
      const formatted = typeof value === 'number' && SPEC_UNITS[key] ? value + ' ' + SPEC_UNITS[key] : String(value);
      return '<dt>' + esc(label) + '</dt><dd>' + esc(formatted) + '</dd>';
    }).join('');
}
function show(span: HTMLElement, entry: WeaponTooltipEntry) {
  const tip = getTip(); clearTimeout(hideTimer);
  let imageUrl = '';
  try {
    const url = new URL(entry.imageUrl || '');
    if (url.protocol === 'https:' || url.protocol === 'http:') imageUrl = url.href;
  } catch { /* no usable image URL */ }
  const title = '<strong>' + esc(entry.nameKo) + (entry.name !== entry.nameKo ? ' <small>' + esc(entry.name) + '</small>' : '') + '</strong>';
  const image = imageUrl ? '<img class="weapon-tooltip-image" src="' + esc(imageUrl) + '" alt="' + esc(entry.nameKo) + '" loading="lazy" referrerpolicy="no-referrer">' : '';
  const maker = [entry.originKo, entry.maker].filter(Boolean).join(' / ');
  const specs = weaponSpecs(entry.specs || {});
  tip.innerHTML = title + image + '<dl><dt>\uBD84\uB958</dt><dd>' + esc(entry.typeKo) + ' (' + esc(entry.systemKo) + ')</dd>' +
    (maker ? '<dt>\uC81C\uC870\uAD6D / \uC81C\uC870\uC0AC</dt><dd>' + esc(maker) + '</dd>' : '') +
    '<dt>\uC124\uBA85</dt><dd>' + esc(entry.description) + '</dd>' +
    (specs ? '<dt class="weapon-tooltip-specs-title">\uD575\uC2EC \uC81C\uC6D0</dt><dd class="weapon-tooltip-specs"><dl>' + specs + '</dl></dd>' : '') + '</dl>';
  tip.hidden = false;
  const r = span.getBoundingClientRect(), b = tip.getBoundingClientRect();
  tip.style.left = String(Math.max(8, Math.min(innerWidth - b.width - 8, r.left))) + 'px';
  const below = r.bottom + 7, above = r.top - b.height - 7;
  const top = below + b.height <= innerHeight - 8 || above < 8 ? below : above;
  tip.style.top = String(Math.max(8, Math.min(innerHeight - b.height - 8, top))) + 'px';
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
