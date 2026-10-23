import './style.css';
import { Globe, type CountryFeature } from './globe';
import { seed, findRecord, setData } from '../shared/data';
import { allForecasts, computeForecast, CATEGORY_KO, fmtKrwRange, fmtQtyRange } from '../shared/forecast';
import type { Forecast, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { initChat } from './chat';
import { esc } from './md';
import { landNeighbors } from '../shared/tension';
import { SYSTEM_COLOR, UNKNOWN_COLOR, MISSING_RGB, mapCountryStyles, rgbCss, systemTint, type CountryMapStyle } from './map-style';
import { est, scorePanelHtml, scoreRowHtml, type ScoreDetail } from './score-panel';

const state = { mode: null as SystemKey | null, flat: false, focus: null as string | null, pinned: false };
let mapStyles = new Map<string, CountryMapStyle>();
/** 판단 점수와 수출 제외 사유는 정보 카드에 표시한다. 지도 색은 시기·자료 충실도로 결정한다. */
interface ScoreSummary { country: string; score: number; grey: boolean; gate: string | null }
const scores = new Map<string, ScoreSummary>();
/** 판단 점수 항목별 내역: 펼친 행(hover 미리보기 또는 클릭 고정)과 국가·체계별 캐시. 점수를 다시 불러오면 비운다 */
const scoreDetail = { open: null as { country: string; system: SystemKey; sticky: boolean } | null, cache: new Map<string, ScoreDetail>(), generation: 0, suppressHover: false, onUpdate: null as (() => void) | null };
const detailKey = (country: string, system: SystemKey) => `${system}:${country}`;
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function boot() {
  let dataVersion = '';
  async function refreshData() {
    const response = await fetch('/api/data', { cache: 'no-store' });
    if (!response.ok) throw new Error('조달 데이터 로드 실패');
    setData(await response.json());
    dataVersion = response.headers.get('x-data-version') || '';
    const status = document.querySelector('#dataUpdated');
    if (status) status.textContent = `자료 갱신 ${seed.meta.collected ? new Date(seed.meta.collected).toLocaleString('ko-KR') : '미확인'}`;
  }
  await refreshData();
  const features: CountryFeature[] = await (await fetch('/countries.json')).json();
  const geography = features.map(f => ({ id: f.id, polygons: f.p }));
  const borders = landNeighbors(geography);
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
      if (!id) { unpin(); globe.setSelected(null); state.focus = null; chat.suggest(null); mapChanged(); return; }
      focusCountry(id, false);
      tip.innerHTML = tipHtml(id, names); state.pinned = true; tip.classList.add('pinned');
      const r = globe.renderer.domElement.getBoundingClientRect();
      placeTip(r.width / 2 + 24, r.height / 2 - 40);
    },
  });
  (window as any).__globe = globe;

  let tipAt = { left: 0, top: 0 };
  function placeTip(x: number, y: number) {
    tip.classList.add('show');
    const w = tip.offsetWidth, h = tip.offsetHeight, W = innerWidth, H = innerHeight;
    let left = x + 18, top = y + 14;
    if (left + w > W - 8) left = x - w - 18;
    if (top + h > H - 90) top = Math.max(60, y - h - 14);
    tipAt = { left: Math.max(8, left), top: Math.max(56, top) };
    tip.style.transform = `translate(${tipAt.left}px, ${tipAt.top}px)`;
  }
  /** 카드 내용이 늘어난 뒤 화면 밖으로 나가는 만큼만 옮긴다(커서 아래 행이 튀지 않게 제자리 유지가 우선) */
  function keepTipOnScreen() {
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const left = Math.max(8, Math.min(tipAt.left, innerWidth - w - 8)), top = Math.max(56, Math.min(tipAt.top, innerHeight - h - 90)); // placeTip과 같은 하단 여백(입력창)
    if (left === tipAt.left && top === tipAt.top) return;
    tipAt = { left, top };
    tip.style.transform = `translate(${left}px, ${top}px)`;
  }
  function unpin() { state.pinned = false; tip.classList.remove('pinned', 'show'); lastHover = null; scoreDetail.open = null; }

  function applyMode() {
    document.querySelectorAll<HTMLButtonElement>('.modes button').forEach(b => b.classList.toggle('on', (b.dataset.sys || null) === state.mode));
    $('#legend').classList.toggle('show', !!state.mode);
    if (!state.mode) { mapStyles.clear(); globe.setBaseColors(null); globe.setSpikes([]); return; }
    const fs = allForecasts(state.mode);
    mapStyles = mapCountryStyles(seed, state.mode, geography, borders);
    globe.setBaseColors(new Map([...mapStyles].map(([id, style]) => [id, style.rgb])), true, new Set([...mapStyles].filter(([, style]) => style.hatched).map(([id]) => id)));
    globe.setSpikes(fs.filter(f => f.status !== 'none' && f.krw != null && seed.countries[f.country]).map(f => ({ id: f.country, lat: seed.countries[f.country].lat, lon: seed.countries[f.country].lon, color: SYSTEM_COLOR[f.system], size: f.size })));
    const mode = state.mode, hue = SYSTEM_COLOR[mode];
    $('#legend').innerHTML = `<strong class="legend-title"><i style="background:${hue}"></i>${esc(seed.systems[mode].ko)} · 진할수록 임박</strong>`
      + ([2, 5, 10, 11] as const).map((years, i) => `<span><i style="background:${rgbCss(systemTint(mode, years))}"></i>${['2년 이내', '3~5년', '6~10년', '10년 이후'][i]}</span>`).join('')
      + `<span><i style="background:${rgbCss(systemTint(mode, 2, true))}"></i>연한 색 · 자료 일부</span><span><i style="background:${UNKNOWN_COLOR}"></i>연한 회색 · 시기 미확인</span>`
      + `<span><i style="background:${rgbCss(MISSING_RGB)}"></i>자료 없음</span><span><i class="hatch" style="--hue:${hue}"></i>빗금 · 인접국 참고</span><small>자료 충분한 육상 인접국 2개 이상<br>빗금은 해당 국가의 확인된 자료가 아닙니다</small><span class="sz"><b></b>막대 높이 · 예상 사업 금액</span>`;
    if (state.pinned && state.focus) tip.innerHTML = tipHtml(state.focus, names);
  }
  let scoreRequest = 0;
  async function loadScores() {
    const mode = state.mode, request = ++scoreRequest;
    scores.clear(); scoreDetail.cache.clear(); scoreDetail.generation++;
    if (!mode) return;
    try {
      const response = await fetch(`/api/scores?system=${mode}`, { cache: 'no-store' });
      if (!response.ok) return;
      const rows = (await response.json()).scores as ScoreSummary[];
      // 응답을 기다리는 사이 모드가 바뀌었거나 더 새 요청이 있으면 버린다(다른 모드 점수로 칠하지 않는다)
      if (request !== scoreRequest || state.mode !== mode) return;
      for (const s of rows) scores.set(s.country, s);
      applyMode();
    } catch { /* 점수 없이 시기·자료 충실도 지도 유지 */ }
  }
  function mapChanged() { dispatchEvent(new Event('radar:map-state')); }
  function setMode(sys: SystemKey | null) { state.mode = sys; scores.clear(); unpin(); applyMode(); void loadScores(); if (state.focus) chat.suggest(state.focus); mapChanged(); }
  function toggleMap(flat?: boolean) {
    state.flat = flat ?? !state.flat; globe.setFlat(state.flat); unpin();
    $('#mapBtn').classList.toggle('on', state.flat);
    mapChanged();
  }
  function focusCountry(id: string, pinTip = true) {
    state.focus = id; const c = seed.countries[id];
    globe.focus(id, c?.lat, c?.lon);
    chat.suggest(id);
    if (pinTip) unpin();
    mapChanged();
  }

  // 상단 버튼
  const modes = $('#modes');
  const items: [string, string][] = [['', '일반'], ...SYSTEM_KEYS.filter(k => seed.systems[k]).map(k => [k, seed.systems[k].ko] as [string, string])];
  modes.innerHTML = items.map(([k, ko]) => `<button data-sys="${esc(k)}"${k ? ` style="--system-color:${SYSTEM_COLOR[k as SystemKey]}"` : ''}>${esc(ko)}</button>`).join('');
  modes.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (b) setMode((b.dataset.sys || null) as SystemKey | null); });
  $('#mapBtn').addEventListener('click', () => toggleMap());

  const chat = initChat({
    names,
    getState: () => ({ mode: state.mode, flat: state.flat, focus: state.focus }),
    dataVersion: () => Number(dataVersion || 0),
    actions: {
      set_mode: (s: SystemKey | null) => setMode(s),
      toggle_map_mode: (flat?: boolean) => toggleMap(flat),
      focus_country: (id: string | null) => { if (id) focusCountry(id); else { state.focus = null; globe.setSelected(null); unpin(); mapChanged(); } },
    },
    modeKo: () => (state.mode ? seed.systems[state.mode].ko : null),
    refreshData: async () => {
      await refreshData();
      for (const [iso, c] of Object.entries(seed.countries)) names[iso] = c.ko;
      applyMode(); void loadScores();
      if (state.focus) { tip.innerHTML = tipHtml(state.focus, names); chat.suggest(state.focus); }
    },
  });
  // 판단 점수 행: 커서를 올리면 미리 보고, 누르면(터치 포함) 고정/닫기. 다른 카드 클릭 동작으로 넘기지 않는다
  const scoreRowOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>('tr.score-row') : null);
  const inScoreArea = (el: EventTarget | null) => el instanceof Element && !!el.closest('tr.score-row, tr.score-detail');
  function openScore(row: HTMLElement, sticky: boolean) {
    const country = row.dataset.scoreCountry!, system = row.dataset.scoreSystem as SystemKey;
    if (!SYSTEM_KEYS.includes(system)) return;
    const open = scoreDetail.open;
    if (open && open.country === country && open.system === system) { open.sticky ||= sticky; return; } // 커서로 연 패널을 누르면 그대로 고정
    const key = detailKey(country, system);
    if (scoreDetail.cache.get(key)?.status === 'error') scoreDetail.cache.delete(key); // 실패한 내역은 다시 열 때 재시도
    scoreDetail.open = { country, system, sticky };
    showScoreDetail();
  }
  function closeScore() { scoreDetail.open = null; showScoreDetail(); }
  function showScoreDetail() {
    const row = tip.querySelector<HTMLElement>('tr.score-row');
    tip.querySelector('tr.score-detail')?.remove();
    if (!row) return;
    const html = scoreSlotHtml(row.dataset.scoreCountry!, row.dataset.scoreSystem as SystemKey);
    row.classList.toggle('open', !!html); row.setAttribute('aria-expanded', String(!!html));
    if (html) row.insertAdjacentHTML('afterend', html);
    if (html && tip.classList.contains('show')) keepTipOnScreen(); // 내용이 늘어도 화면 안에 둔다
  }
  scoreDetail.onUpdate = showScoreDetail;
  tip.addEventListener('mouseover', event => {
    const row = scoreRowOf(event.target);
    if (row && !scoreDetail.open && !scoreDetail.suppressHover) openScore(row, false);
  });
  tip.addEventListener('mouseout', event => {
    if (!inScoreArea(event.target) || inScoreArea(event.relatedTarget)) return;
    scoreDetail.suppressHover = false;
    if (scoreDetail.open && !scoreDetail.open.sticky) closeScore();
  });
  tip.addEventListener('keydown', event => {
    const row = scoreRowOf(event.target);
    if (!row || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault(); event.stopPropagation();
    if (scoreDetail.open?.sticky) closeScore(); else openScore(row, true);
  });
  tip.addEventListener('click', event => {
    const scoreRow = scoreRowOf(event.target);
    if (scoreRow || inScoreArea(event.target)) {
      event.stopPropagation();
      if (!scoreRow) return; // 패널 안 클릭은 아무 동작도 하지 않는다
      if (scoreDetail.open?.sticky) { closeScore(); scoreDetail.suppressHover = true; } else openScore(scoreRow, true);
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-report-system][data-report-country]');
    if (!button) return;
    const country = button.dataset.reportCountry!, system = button.dataset.reportSystem as SystemKey;
    if (!SYSTEM_KEYS.includes(system) || !findRecord(country, system)) return;
    // 보고서는 채팅 요청 없이 바로 보여주고 다음 메시지에 첨부한다
    setMode(system); focusCountry(country); chat.open();
    void chat.viewReport(country, system);
  });
  addEventListener('keydown', e => { if (e.key === 'Escape') { unpin(); chat.collapse(); } });
  applyMode();
  (window as any).__app = { setMode, toggleMap, focusCountry, state, getAppContext: chat.getAppContext };
  document.body.classList.add('ready');
  const checkData = async () => {
    if (document.hidden) return;
    try {
      const result = await fetch('/api/data/version', { cache: 'no-store' });
      const version = await result.json();
      if (String(version.revision) !== dataVersion) { await refreshData(); for (const [id, c] of Object.entries(seed.countries)) names[id] = c.ko; applyMode(); void loadScores(); }
    } catch { /* 다음 활성화·주기 확인에서 재시도 */ }
  };
  setInterval(checkData, 5000);
  addEventListener('focus', checkData);
}

/** 펼친 판단 점수 행 아래에 넣을 패널. 캐시에 없으면 그때 불러온다(국가·체계별 1회, 점수 재로딩 시 무효화) */
function scoreSlotHtml(country: string, system: SystemKey) {
  const open = scoreDetail.open;
  if (!open || open.country !== country || open.system !== system || state.mode !== system) return '';
  const key = detailKey(country, system);
  let detail = scoreDetail.cache.get(key);
  if (!detail) { detail = { status: 'loading' }; scoreDetail.cache.set(key, detail); void fetchScoreDetail(country, system, key); }
  return scorePanelHtml(detail, SYSTEM_COLOR[system]);
}
async function fetchScoreDetail(country: string, system: SystemKey, key: string) {
  const generation = scoreDetail.generation;
  let detail: ScoreDetail;
  try {
    const response = await fetch(`/api/scores/${encodeURIComponent(country)}?system=${encodeURIComponent(system)}`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    detail = response.ok && Array.isArray(body.components) ? { status: 'ok', data: body } : { status: 'error', message: `항목별 점수를 불러오지 못했습니다${body?.error ? ` · ${String(body.error)}` : ''}` };
  } catch { detail = { status: 'error', message: '항목별 점수를 불러오지 못했습니다 · 연결을 확인하세요' }; }
  if (generation !== scoreDetail.generation) return; // 그 사이 점수·모드·자료 버전이 바뀌었다
  scoreDetail.cache.set(key, detail);
  const open = scoreDetail.open;
  if (open && detailKey(open.country, open.system) === key) scoreDetail.onUpdate?.();
}

function fmtWin(f: Forecast) { return f.window ? `${f.window[0]}~${f.window[1]}년` : '—'; }
function host(u: string) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function safeHref(u: string) { try { const url = new URL(u); return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : '#'; } catch { return '#'; } }

function tipHtml(id: string, names: Record<string, string>) {
  const meta = seed.countries[id]; const name = esc(names[id] ?? id);
  const mode = state.mode;
  if (!mode) {
    const recs = seed.records.filter(r => r.country === id);
    if (!recs.length) return `<div class="th">${esc(meta?.flag ?? '')} ${name}</div>`;
    const chips = recs.map(r => { const f = computeForecast(r); return `<button type="button" class="chip" data-report-country="${esc(id)}" data-report-system="${r.system}" aria-label="${name} ${esc(f.systemKo)} 보고서 보기" title="${esc(f.systemKo)} 지도로 전환하고 보고서 열기"><i style="background:${SYSTEM_COLOR[r.system]}"></i>${esc(f.systemKo)}</button>`; }).join('');
    return `<div class="th">${esc(meta.flag)} ${name}</div><div class="chips">${chips}</div>`;
  }
  const rec = findRecord(id, mode);
  const sysKo = esc(seed.systems[mode].ko);
  const sc = scores.get(id);
  const style = mapStyles.get(id);
  if (scoreDetail.open && (scoreDetail.open.country !== id || scoreDetail.open.system !== mode)) scoreDetail.open = null;
  const scoreRow = sc ? scoreRowHtml(id, mode, sc.grey ? `제외 · ${esc((sc.gate || '').slice(0, 60))}` : `${sc.score}/100`, !!scoreDetail.open) + scoreSlotHtml(id, mode) : '';
  if (!rec || style?.coverage === 'missing') return `<div class="th">${esc(meta?.flag ?? '')} ${name} · ${sysKo}<span class="badge" style="--c:${style?.hatched ? SYSTEM_COLOR[mode] : UNKNOWN_COLOR}">${style?.hatched ? '인접국 참고' : '데이터 없음'}</span></div>${style?.hatched ? `<p class="map-note">${style.neighbors.map(n => esc(names[n] ?? n)).join(' · ')}의 자료가 충분해 빗금으로 표시합니다. 이 국가의 보유 장비나 교체 일정은 확인되지 않았습니다.</p>` : '<p class="map-note">이 무기체계의 자료가 아직 없습니다.</p>'}${scoreRow ? `<table>${scoreRow}</table>` : ''}`;
  const f = computeForecast(rec);
  const cur = f.current;
  const be = (b: { est: string[] }, k: string) => b.est.includes(k);
  const rows: [string, string][] = [];
  rows.push(['현재 주력', cur ? `${esc(cur.model)} · 도입 ${cur.introYear ?? '미확인'}${est(be(cur, 'introYear'))} · ${cur.qty == null ? '수량 미확인' : `${cur.qty.toLocaleString()}${esc(f.unit)}`}${est(be(cur, 'qty'))}` : '보유 장비 조사 필요']);
  if (cur) rows.push(['설계 수명', `${cur.life}년${est(f.lifeEst)}${cur.ext ? ` + MRO ${cur.ext}년` : ''}${cur.year == null ? ' · 도입 연도 확인 필요' : ` → ${cur.year}년`}`]);
  rows.push(['교체 예상', f.window ? `${fmtWin(f)} <span class="pred">예측</span>${f.status === 'next' ? ' · 후속 주기' : f.status === 'plan' ? ' · 사업 계획' : ''}` : '도입 연도·사업 일정 조사 필요']);
  const mro = rec.mro?.[rec.mro.length - 1];
  if (mro) rows.push(['최근 MRO', `${mro.year}${est(!!mro.est?.includes('year'))} ${esc(mro.text)}`]);
  if (rec.awarded && cur) rows.push(['최근 계약', `${rec.awarded.year} ${esc(rec.awarded.text)}`]);
  if (rec.plan) rows.push(['사업 계획', esc(rec.plan.text)]);
  if (f.status !== 'none') rows.push(['예상 사업', `${fmtQtyRange(f.qty, esc(f.unit))} · ${fmtKrwRange(f.krw)} <span class="pred">예측</span>${est(f.krwEst)}`]);
  rows.push(['신뢰도', `${f.confidence} (근거 ${f.nSources}건)`]);
  if (style?.coverage === 'partial') rows.push(['지도 표시', f.remaining == null ? '연한 회색 · 시기 미확인' : '연한 색 · 자료 일부']);
  const links = f.sources.slice(0, 4).map((s, i) => `<a href="${safeHref(s.u)}" target="_blank" rel="noopener" title="${esc(s.t)}">${i + 1}. ${esc(host(s.u))}</a>`).join('');
  return `<div class="th">${esc(meta.flag)} ${name} · ${sysKo}<span class="badge" style="--c:${SYSTEM_COLOR[mode]}">${style?.coverage === 'partial' ? '자료 일부' : CATEGORY_KO[f.category]}</span></div>
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}${scoreRow}</table>
    <div class="src">${links}${f.sources.length > 4 ? `<span>+${f.sources.length - 4}</span>` : ''}</div>`;
}

boot().catch(e => { console.error(e); document.body.classList.add('ready'); document.body.insertAdjacentHTML('beforeend', `<div class="fatal">${esc(String(e))}</div>`); });
