import './style.css';
import { Globe, type CountryFeature } from './globe';
import { seed, findRecord } from '../shared/data';
import { allForecasts, computeForecast, CATEGORY_KO, fmtKrwRange } from '../shared/forecast';
import type { Forecast, SystemKey, Category } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { initChat } from './chat';
import { esc } from './md';

export const CAT_COLOR: Record<Category, string> = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', blue: '#4c8dff', gray: '#7c8594' };
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

const state = { mode: null as SystemKey | null, flat: false, focus: null as string | null, pinned: false };
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function boot() {
  const features: CountryFeature[] = await (await fetch('/countries.json')).json();
  const names: Record<string, string> = {};
  for (const f of features) names[f.id] = seed.countries[f.id]?.ko ?? f.ko;
  const tip = $('#tip');
  let lastHover: string | null = null;

  const globe = new Globe($('#globe'), features, {
    onHover(id, x, y) {
      if (state.pinned) return;
      if (!id) { tip.classList.remove('show'); lastHover = null; return; }
      if (id !== lastHover) { tip.innerHTML = tipHtml(id, names); lastHover = id; }
      placeTip(x, y);
    },
    onClick(id) {
      if (!id) { unpin(); globe.setSelected(null); state.focus = null; chat.suggest(null); return; }
      focusCountry(id, false);
      tip.innerHTML = tipHtml(id, names); state.pinned = true; tip.classList.add('pinned');
      const r = globe.renderer.domElement.getBoundingClientRect();
      placeTip(r.width / 2 + 24, r.height / 2 - 40);
    },
  });
  (window as any).__globe = globe;

  function placeTip(x: number, y: number) {
    tip.classList.add('show');
    const w = tip.offsetWidth, h = tip.offsetHeight, W = innerWidth, H = innerHeight;
    let left = x + 18, top = y + 14;
    if (left + w > W - 8) left = x - w - 18;
    if (top + h > H - 90) top = Math.max(60, y - h - 14);
    tip.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(56, top)}px)`;
  }
  function unpin() { state.pinned = false; tip.classList.remove('pinned', 'show'); lastHover = null; }

  function applyMode() {
    document.querySelectorAll<HTMLButtonElement>('.modes button').forEach(b => b.classList.toggle('on', (b.dataset.sys || null) === state.mode));
    $('#legend').classList.toggle('show', !!state.mode);
    if (!state.mode) { globe.setBaseColors(null); globe.setSpikes([]); return; }
    const fs = allForecasts(state.mode);
    const colors = new Map<string, [number, number, number]>();
    const base: [number, number, number] = [0.09, 0.12, 0.16];
    for (const f of fs) {
      const c = hex(CAT_COLOR[f.category]); const k = f.category === 'gray' ? 0.55 : 0.42 + 0.5 * f.size;
      colors.set(f.country, [base[0] + (c[0] - base[0]) * k, base[1] + (c[1] - base[1]) * k, base[2] + (c[2] - base[2]) * k]);
    }
    globe.setBaseColors(colors, true);
    globe.setSpikes(fs.filter(f => f.status !== 'none').map(f => ({ id: f.country, lat: seed.countries[f.country].lat, lon: seed.countries[f.country].lon, color: CAT_COLOR[f.category], size: f.size })));
    if (state.pinned && state.focus) tip.innerHTML = tipHtml(state.focus, names);
  }
  function setMode(sys: SystemKey | null) { state.mode = sys; applyMode(); if (state.focus) chat.suggest(state.focus); }
  function toggleMap(flat?: boolean) {
    state.flat = flat ?? !state.flat; globe.setFlat(state.flat); unpin();
    $('#mapBtn').classList.toggle('on', state.flat);
  }
  function focusCountry(id: string, pinTip = true) {
    state.focus = id; const c = seed.countries[id];
    globe.focus(id, c?.lat, c?.lon);
    chat.suggest(id);
    if (pinTip) unpin();
  }

  // 상단 버튼
  const modes = $('#modes');
  const items: [string, string][] = [['', '일반'], ...SYSTEM_KEYS.map(k => [k, seed.systems[k].ko] as [string, string])];
  modes.innerHTML = items.map(([k, ko]) => `<button data-sys="${k}">${ko}</button>`).join('');
  modes.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (b) setMode((b.dataset.sys || null) as SystemKey | null); });
  $('#mapBtn').addEventListener('click', () => toggleMap());
  $('#legend').innerHTML = (['red', 'orange', 'yellow', 'blue', 'gray'] as Category[]).map(c => `<span><i style="background:${CAT_COLOR[c]}"></i>${CATEGORY_KO[c]}</span>`).join('') + '<span class="sz"><b></b>규모</span>';

  const chat = initChat({
    names,
    getState: () => ({ mode: state.mode, flat: state.flat, focus: state.focus }),
    actions: {
      set_mode: (s: SystemKey | null) => setMode(s),
      toggle_map_mode: (flat?: boolean) => toggleMap(flat),
      focus_country: (id: string) => focusCountry(id),
    },
    modeKo: () => (state.mode ? seed.systems[state.mode].ko : null),
  });
  addEventListener('keydown', e => { if (e.key === 'Escape') { unpin(); chat.collapse(); } });
  applyMode();
  (window as any).__app = { setMode, toggleMap, focusCountry, state };
  document.body.classList.add('ready');
}

function fmtWin(f: Forecast) { return f.window ? `${f.window[0]}~${f.window[1]}년` : '—'; }
const est = (on: boolean) => (on ? ' <em>추정</em>' : '');
function host(u: string) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }

function tipHtml(id: string, names: Record<string, string>) {
  const meta = seed.countries[id]; const name = esc(names[id] ?? id);
  const mode = state.mode;
  if (!mode) {
    const recs = seed.records.filter(r => r.country === id);
    if (!recs.length) return `<div class="th">${meta?.flag ?? ''} ${name}</div>`;
    const chips = recs.map(r => { const f = computeForecast(r); return `<span class="chip"><i style="background:${CAT_COLOR[f.category]}"></i>${f.systemKo}</span>`; }).join('');
    return `<div class="th">${meta.flag} ${name}</div><div class="chips">${chips}</div>`;
  }
  const rec = findRecord(id, mode);
  const sysKo = seed.systems[mode].ko;
  if (!rec) return `<div class="th">${meta?.flag ?? ''} ${name} · ${sysKo}<span class="badge" style="--c:${CAT_COLOR.gray}">데이터 없음</span></div>`;
  const f = computeForecast(rec);
  const cur = f.current;
  const be = (b: { est: string[] }, k: string) => b.est.includes(k);
  const rows: [string, string][] = [];
  rows.push(['현재 주력', cur ? `${esc(cur.model)} · 도입 ${cur.introYear}${est(be(cur, 'introYear'))} · ${cur.qty.toLocaleString()}${f.unit}${est(be(cur, 'qty'))}` : rec.awarded ? esc(rec.awarded.text) : '—']);
  if (cur) rows.push(['설계 수명', `${cur.life}년${est(true)}${cur.ext ? ` + MRO ${cur.ext}년` : ''} → ${cur.year}년`]);
  rows.push(['교체 예상', `${fmtWin(f)} <span class="pred">예측</span>${f.status === 'next' ? ' · 후속 주기' : f.status === 'plan' ? ' · 사업 계획' : ''}`]);
  const mro = rec.mro?.[rec.mro.length - 1];
  if (mro) rows.push(['최근 MRO', `${mro.year}${est(!!mro.est?.includes('year'))} ${esc(mro.text)}`]);
  if (rec.awarded && cur) rows.push(['최근 계약', `${rec.awarded.year} ${esc(rec.awarded.text)}`]);
  if (rec.plan) rows.push(['사업 계획', esc(rec.plan.text)]);
  if (f.status !== 'none') rows.push(['예상 사업', `${f.qty[0].toLocaleString()}~${f.qty[1].toLocaleString()}${f.unit} · ${fmtKrwRange(f.krw)} <span class="pred">예측</span>${est(f.krwEst)}`]);
  rows.push(['신뢰도', `${f.confidence} (근거 ${f.nSources}건)`]);
  const links = f.sources.slice(0, 4).map((s, i) => `<a href="${s.u}" target="_blank" rel="noopener" title="${esc(s.t)}">${i + 1}. ${esc(host(s.u))}</a>`).join('');
  return `<div class="th">${meta.flag} ${name} · ${sysKo}<span class="badge" style="--c:${CAT_COLOR[f.category]}">${CATEGORY_KO[f.category]}</span></div>
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    <div class="src">${links}${f.sources.length > 4 ? `<span>+${f.sources.length - 4}</span>` : ''}</div>`;
}

boot().catch(e => { console.error(e); document.body.insertAdjacentHTML('beforeend', `<div class="fatal">로드 실패</div>`); });
