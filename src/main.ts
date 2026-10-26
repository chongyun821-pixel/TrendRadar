import './style.css';
import { Globe, type CountryFeature } from './globe';
import { seed, findRecord, setData } from '../shared/data';
import { allForecasts, computeForecast, fmtKrwRange, fmtQtyRange } from '../shared/forecast';
import type { Forecast, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { initChat } from './chat';
import { esc } from './md';
import { landNeighbors } from '../shared/tension';
import { SYSTEM_COLOR, MISSING_RGB, rgbCss, hexRgb, systemTint, timingLabel, leadingWeapons, mapSizes, mapCountryStyles, type CountryMapStyle, type WeaponScore } from './map-style';
import { est, scorePanelHtml, scoreRowHtml, type ScoreDetail } from './score-panel';
import { DEFAULT_DISPLAY, applyDisplayPatch, dimRgb, displayStyle, displaySummary, type MapDisplay, type MapDisplayPatch, type MapZoom } from '../shared/map-display';
import { renderRankingReport } from './ranking-report';
import { mountTimeline, purgeTimeline } from './plotly-timeline';
import { shortcutAction, isEditableTarget } from './shortcuts';
import { searchMatches, type SearchCountry, type SearchResult, type SearchSystem } from './search';
import { rankingToDoc } from '../shared/report-doc';
import { initReportEditor } from './report-editor';
import { countryName } from '../shared/country-name';
import { initSettings } from './settings';
import { countryCatalog } from '../shared/countries';
import { pointCountryFeatures } from './point-countries';
import { decorateWeaponTerms } from './weapon-tooltip';

const state = { mode: null as SystemKey | null, flat: false, focus: null as string | null, pinned: false, display: DEFAULT_DISPLAY as MapDisplay };
let mapStyles = new Map<string, CountryMapStyle>();
/** 종합 점수와 수출 제외 사유는 정보 카드에 표시한다. 인접국 영향 점수와는 별도다. */
interface ScoreSummary extends WeaponScore { gate: string | null }
const scores = new Map<string, ScoreSummary>();
/** 종합 점수 항목별 내역: 펼친 행(hover 미리보기 또는 클릭 고정)과 국가, 체계별 캐시. 점수를 다시 불러오면 비운다 */
const scoreDetail = { open: null as { country: string; system: SystemKey; sticky: boolean } | null, cache: new Map<string, ScoreDetail>(), generation: 0, suppressHover: false, onUpdate: null as (() => void) | null };
const detailKey = (country: string, system: SystemKey) => `${system}:${country}`;
let bestWeapons = new Map<string, WeaponScore>();
const scoreKey = (system: SystemKey, country: string) => `${system}:${country}`;
/** 표시 조정으로 어둡게 할 때 다가가는 바탕색(지구본의 자료 없는 국가 색) */
const DIM_BASE_RGB: [number, number, number] = [0.075, 0.105, 0.14];
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function boot() {
  const reportEditor = initReportEditor();
  addEventListener('radar:open-ranking-report-editor', () => reportEditor.open(rankingToDoc(seed)));
  let dataVersion = '';
  let selectedTimeline: [number, number] | null = null;
  async function refreshData() {
    const response = await fetch('/api/data', { cache: 'no-store' });
    if (!response.ok) throw new Error('조달 데이터 로드 실패');
    setData(await response.json());
    scores.clear(); bestWeapons.clear(); scoreDetail.cache.clear(); scoreDetail.generation++;
    const rankingReport = document.querySelector<HTMLElement>('#rankingReport');
    if (rankingReport) {
      purgeTimeline(rankingReport.querySelector('#rankTimelinePlot'));
      rankingReport.innerHTML = renderRankingReport(seed);
      const hero = rankingReport.querySelector('.rank-hero');
      if (hero) hero.insertAdjacentHTML('beforeend', '<button type="button" class="rank-export-button">내보내기</button>');
      if (!rankingReport.hidden) void showPlotlyTimeline();
    }
    dataVersion = response.headers.get('x-data-version') || '';
    const status = document.querySelector('#dataUpdated');
    if (status) status.textContent = `자료 갱신 ${seed.meta.collected ? new Date(seed.meta.collected).toLocaleString('ko-KR') : '미확인'}`;
  }
  await refreshData();
  const shapes: CountryFeature[] = await (await fetch('/countries.json')).json();
  // 인접국 계산은 실제 경계만 쓰고, 경계가 없는 카탈로그 국가는 지도, 지구본에 점으로만 더한다
  const geography = shapes.map(f => ({ id: f.id, polygons: f.p }));
  const features: CountryFeature[] = [...shapes, ...pointCountryFeatures(shapes, countryCatalog)];
  const borders = landNeighbors(geography);
  const names: Record<string, string> = {};
  for (const f of features) names[f.id] = countryName(f.id, seed);
  const searchCountries: SearchCountry[] = features.map(f => ({ id: f.id, ko: countryName(f.id, seed), en: f.en }));
  const tip = $('#tip');
  let lastHover: string | null = null;
  function renderTip(id: string) { tip.innerHTML = tipHtml(id, names); void decorateWeaponTerms(tip); }
  function pinCountry(id: string, x?: number, y?: number) {
    focusCountry(id, false); renderTip(id); state.pinned = true; tip.classList.add('pinned');
    if (x == null || y == null) { const r = globe.renderer.domElement.getBoundingClientRect(); x = r.width / 2 + 24; y = r.height / 2 - 40; }
    placeTip(x, y);
  }

  const globe = new Globe($('#globe'), features, {
    onHover(id, x, y) {
      if (state.pinned) return;
      if (!id) { tip.classList.remove('show'); lastHover = null; return; }
      if (id !== lastHover) { renderTip(id); lastHover = id; }
      placeTip(x, y);
    },
    onClick(id) {
      if (!id) { unpin(); globe.setSelected(null); state.focus = null; chat.suggest(null); mapChanged(); return; }
      pinCountry(id);
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
    $('#legend').classList.add('show');
    let fs: Forecast[];
    if (state.mode) {
      fs = allForecasts(state.mode);
      mapStyles = mapCountryStyles(seed, state.mode, geography, borders);
    } else {
      bestWeapons = leadingWeapons(seed, scores.values());
      mapStyles = new Map();
      const styles = new Map(SYSTEM_KEYS.map(system => [system, mapCountryStyles(seed, system, geography, borders)]));
      for (const [country, best] of bestWeapons) mapStyles.set(country, styles.get(best.system)!.get(country)!);
      fs = [];
    }
    const ranking = $('#hatchRanking');
    ranking.hidden = !state.mode;
    if (state.mode) {
      const top = [...mapStyles]
        .filter(([, style]) => style.hatched && style.referenceRank != null)
        .map(([country]) => ({ country, score: scores.get(scoreKey(state.mode!, country)) }))
        .sort((a, b) => {
          const aScore = a.score ? (a.score.grey ? 0 : a.score.score) : -1;
          const bScore = b.score ? (b.score.grey ? 0 : b.score.score) : -1;
          return bScore - aScore || a.country.localeCompare(b.country);
        }).slice(0, 5);
      ranking.style.setProperty('--ranking-color', SYSTEM_COLOR[state.mode]);
      ranking.innerHTML = `<div class="hatch-ranking-heading"><i aria-hidden="true"></i><div><h2 id="hatchRankingTitle">종합 점수</h2></div></div>`
        + (top.length ? `<ol>${top.map(({ country, score }, index) => {
          const value = score ? (score.grey ? '제외' : `${score.score.toFixed(1)}<small>점</small>`) : '—';
          return `<li><button type="button" data-hatch-country="${esc(country)}" title="${esc(names[country] ?? country)} 지도에서 보기"><span class="hatch-ranking-number">${index + 1}</span><span class="hatch-ranking-country">${esc(names[country] ?? country)}</span><strong>${value}</strong></button></li>`;
        }).join('')}</ol>`
          : '<p class="hatch-ranking-empty">조건에 맞는 빗금 국가가 없습니다.</p>');
    } else ranking.innerHTML = '';
    // 챗봇 표시 조정(숨김, 특정 국가만, 강조, 빗금, 막대)을 색과 막대에 반영한다
    const shown = displayStyle(state.display,
      new Map([...mapStyles].map(([id, style]) => [id, style.rgb])),
      new Set([...mapStyles].filter(([, style]) => style.hatched).map(([id]) => id)), DIM_BASE_RGB);
    globe.setBaseColors(shown.colors, true, shown.hatched);
    const visible = state.display.bars ? fs.filter(f => f.status !== 'none' && f.krw != null && seed.countries[f.country] && shown.shows(f.country)) : [];
    const sizes = mapSizes(visible);
    globe.setSpikes(visible.filter(f => (sizes.get(f.country) ?? 0) > 0).map(f => ({ id: f.country, lat: seed.countries[f.country].lat, lon: seed.countries[f.country].lon, color: shown.dimmed(f.country) ? rgbCss(dimRgb(hexRgb(SYSTEM_COLOR[f.system]), DIM_BASE_RGB)) : SYSTEM_COLOR[f.system], size: sizes.get(f.country)! })));
    if (state.mode) {
      const mode = state.mode, hue = SYSTEM_COLOR[mode];
      $('#legend').innerHTML = `<strong class="legend-title"><i style="background:${hue}"></i>${esc(seed.systems[mode].ko)}</strong>`
        + ([3, 10, 11] as const).map(years => `<span><i style="background:${rgbCss(systemTint(mode, years))}"></i>${timingLabel(years)}</span>`).join('')
        + `<span><i class="hatch" style="--hue:${hue}"></i>인접국 자료로 도입 가능성을 짐작한 국가</span><span><i style="background:${rgbCss(MISSING_RGB)}"></i>자료가 없는 국가</span>`;
    } else {
      $('#legend').innerHTML = `<strong class="legend-title">국가별 수주 가능성이 가장 높은 무기</strong>`
        + SYSTEM_KEYS.map(system => `<span><i style="background:${SYSTEM_COLOR[system]}"></i>${esc(seed.systems[system].ko)}</span>`).join('');
    }
    const adjusted = displaySummary(state.display, id => names[id] ?? id);
    if (adjusted) $('#legend').insertAdjacentHTML('beforeend', `<small class="display-note">${esc(adjusted)}</small>`);
    $('#legend').classList.toggle('show', state.display.legend);
    if (state.pinned && state.focus) renderTip(state.focus);
  }
  function setDisplay(patch: MapDisplayPatch) { state.display = applyDisplayPatch(state.display, patch); applyMode(); mapChanged(); }
  let scoreRequest = 0;
  async function loadScores() {
    const mode = state.mode, request = ++scoreRequest, version = dataVersion;
    scoreDetail.cache.clear(); scoreDetail.generation++;
    await Promise.allSettled((mode ? [mode] : SYSTEM_KEYS).map(async system => {
      const response = await fetch(`/api/scores?system=${system}`, { cache: 'no-store' });
      if (!response.ok) return;
      const rows = (await response.json()).scores as ScoreSummary[];
      if (dataVersion !== version) return;
      for (const row of rows) scores.set(scoreKey(system, row.country), { ...row, system });
    }));
    if (request === scoreRequest && state.mode === mode && dataVersion === version) applyMode();
  }
  function mapChanged() { dispatchEvent(new Event('radar:map-state')); }
  function setMode(sys: SystemKey | null) { state.mode = sys; unpin(); applyMode(); void loadScores(); if (state.focus) chat.suggest(state.focus); mapChanged(); }
  function toggleMap(flat?: boolean) {
    state.flat = flat ?? !state.flat; globe.setFlat(state.flat); unpin();
    $('#mapBtn').classList.toggle('on', state.flat);
    $('#mapBtn').textContent = state.flat ? '3D 지구본' : '2D 지도';
    $('#mapBtn').setAttribute('aria-pressed', String(state.flat));
    applyMode();
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
  let currentView: 'map' | 'report' | 'settings' = 'map';
  let previousView: 'map' | 'report' = 'map';
  function setView(view: 'map' | 'report' | 'settings') {
    if (view === 'settings' && currentView !== 'settings') previousView = currentView as 'map' | 'report';
    currentView = view;
    document.body.classList.toggle('report-view', view === 'report');
    document.body.classList.toggle('settings-view-active', view === 'settings');
    $('#rankingReport').hidden = view !== 'report';
    $('#settingsView').hidden = view !== 'settings';
    for (const [id, active] of [['mapViewBtn', view === 'map'], ['reportViewBtn', view === 'report'], ['settingsButton', view === 'settings']] as const) {
      $( `#${id}`).classList.toggle('on', active);
      if (active) $(`#${id}`).setAttribute('aria-current', 'page'); else $(`#${id}`).removeAttribute('aria-current');
    }
    if (view === 'report') { unpin(); void showPlotlyTimeline(); }
  }
  $('#mapViewBtn').addEventListener('click', () => setView('map'));
  $('#reportViewBtn').addEventListener('click', () => setView('report'));

  const searchSystems: SearchSystem[] = items.slice(1).map(([id, label]) => ({ id: id as SystemKey, label, aliases: [seed.systems[id as SystemKey].ko, ...seed.systems[id as SystemKey].hanwha] }));
  const searchOverlay = document.createElement('section');
  searchOverlay.className = 'global-search';
  searchOverlay.hidden = true;
  searchOverlay.setAttribute('role', 'dialog');
  searchOverlay.setAttribute('aria-label', '국가와 무기 체계 검색');
  searchOverlay.innerHTML = '<div class="global-search-box"><input class="global-search-input" type="search" autocomplete="off" placeholder="국가나 무기 체계를 입력하세요" aria-label="국가나 무기 체계를 입력하세요"><div class="global-search-results" role="listbox"></div></div>';
  document.body.append(searchOverlay);
  const searchInput = searchOverlay.querySelector<HTMLInputElement>('.global-search-input')!;
  const searchResults = searchOverlay.querySelector<HTMLElement>('.global-search-results')!;
  let searchSelection: { kind: 'country'; country: SearchCountry } | { kind: 'system'; system: SearchSystem } | null = null;
  let searchItems: SearchResult[] = [];
  let searchIndex = 0;
  function closeSearch() {
    searchOverlay.hidden = true;
    searchSelection = null;
    searchItems = [];
  }
  function openSearch(query = '') {
    searchSelection = null;
    searchInput.value = query;
    searchOverlay.hidden = false;
    renderSearch();
    searchInput.focus();
  }
  function renderSearch() {
    if (searchSelection?.kind === 'country') {
      const ordered = [...searchSystems].sort((a, b) => Number(b.id === state.mode) - Number(a.id === state.mode));
      searchItems = ordered.filter(system => !searchInput.value.trim() || searchMatches(searchInput.value, [], [system]).length > 0)
        .map(system => ({ kind: 'system' as const, system, label: system.label }));
    } else if (searchSelection?.kind === 'system') {
      searchItems = searchCountries.filter(country => !searchInput.value.trim() || searchMatches(searchInput.value, [country], []).length > 0)
        .map(country => ({ kind: 'country' as const, country, label: countryName(country.id, seed) }));
    } else searchItems = searchMatches(searchInput.value, searchCountries, searchSystems);
    searchIndex = Math.min(searchIndex, Math.max(0, searchItems.length - 1));
    searchResults.innerHTML = searchItems.map((item, index) => {
      const hint = item.kind === 'combined' ? countryName(item.country.id, seed) : item.kind === 'country' ? countryName(item.country.id, seed) : item.system.id.toUpperCase();
      return `<button type="button" role="option" aria-selected="${index === searchIndex}" data-search-index="${index}"><span>${esc(item.label)}</span><small>${esc(hint)}</small></button>`;
    }).join('') || '<p class="global-search-empty">검색 결과가 없습니다.</p>';
  }
  function applySearch(country: SearchCountry, system: SearchSystem) {
    const keepReportView = document.body.classList.contains('report-view');
    closeSearch();
    chat.dispatch([
      { type: 'set_mode', system: system.id },
      { type: 'focus_country', country: country.id },
      ...(keepReportView ? [{ type: 'set_app_view' as const, view: 'report' as const }] : []),
    ]);
  }
  function chooseSearch(index: number) {
    const item = searchItems[index];
    if (!item) return;
    if (item.kind === 'combined') { applySearch(item.country, item.system); return; }
    if (item.kind === 'country') {
      if (searchSelection?.kind === 'system') { applySearch(item.country, searchSelection.system); return; }
      searchSelection = { kind: 'country', country: item.country };
    } else {
      if (searchSelection?.kind === 'country') { applySearch(searchSelection.country, item.system); return; }
      searchSelection = { kind: 'system', system: item.system };
    }
    searchInput.value = '';
    searchIndex = 0;
    renderSearch();
  }
  searchInput.addEventListener('input', () => { searchIndex = 0; renderSearch(); });
  searchOverlay.addEventListener('click', event => {
    if (event.target === searchOverlay) { closeSearch(); return; }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-search-index]');
    if (button) chooseSearch(Number(button.dataset.searchIndex));
  });
  searchOverlay.addEventListener('mousemove', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-search-index]');
    if (!button) return;
    searchIndex = Number(button.dataset.searchIndex);
    searchResults.querySelectorAll('[data-search-index]').forEach((el, index) => el.setAttribute('aria-selected', String(index === searchIndex)));
  });
  searchOverlay.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      searchIndex = (searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + searchItems.length) % Math.max(1, searchItems.length);
      renderSearch();
    } else if (event.key === 'Enter') { event.preventDefault(); chooseSearch(searchIndex); }
  });
  $('#hatchRanking').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-hatch-country]');
    if (button) focusCountry(button.dataset.hatchCountry!);
  });

  const chat = initChat({
    names,
    getState: () => ({ mode: state.mode, flat: state.flat, focus: state.focus, display: state.display }),
    dataVersion: () => Number(dataVersion || 0),
    actions: {
      set_mode: (s: SystemKey | null) => setMode(s),
      toggle_map_mode: (flat?: boolean) => toggleMap(flat),
      focus_country: (id: string | null) => { if (id) focusCountry(id); else { state.focus = null; globe.setSelected(null); unpin(); mapChanged(); } },
      set_display: (patch: MapDisplayPatch) => setDisplay(patch),
      zoom: (z: MapZoom) => globe.zoom(z),
      set_app_view: (view: 'map' | 'report') => setView(view),
      set_chat_open: (open: boolean) => chat.setChatOpen(open, open),
      open_search: (query?: string) => openSearch(query),
      open_settings: (toggle?: boolean) => dispatchEvent(new CustomEvent('radar:open-settings', { detail: { toggle } })),
    },
    modeKo: () => (state.mode ? seed.systems[state.mode].ko : null),
    refreshData: async () => {
      await refreshData();
      for (const [iso, c] of Object.entries(seed.countries)) names[iso] = c.ko;
      applyMode(); void loadScores();
      if (state.focus) { renderTip(state.focus); chat.suggest(state.focus); }
    },
  });
  initSettings({ setView: view => setView(view) });
  // 종합 점수 행: 커서를 올리면 미리 보고, 누르면(터치 포함) 고정/닫기. 다른 카드 클릭 동작으로 넘기지 않는다
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
    void decorateWeaponTerms(tip);
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
  // 정보 카드 클릭: 종합 점수 행은 항목별 점수를 열고 닫으며, 첨부와 Word 내보내기 버튼은 해당 국가·체계를 처리한다.
  tip.addEventListener('click', event => {
    const attach = (event.target as HTMLElement).closest<HTMLButtonElement>('button.tip-attach[data-attach-country][data-attach-system]');
    if (attach) { event.stopPropagation(); void chat.attachReport(attach.dataset.attachCountry!, attach.dataset.attachSystem as SystemKey); return; }
    const exportButton = (event.target as HTMLElement).closest<HTMLButtonElement>('button.tip-export[data-export-country][data-export-system]');
    if (exportButton) { event.stopPropagation(); chat.exportWordReport(exportButton.dataset.exportCountry!, exportButton.dataset.exportSystem as SystemKey); return; }
    const scoreRow = scoreRowOf(event.target);
    if (scoreRow || inScoreArea(event.target)) {
      event.stopPropagation();
      if (!scoreRow) return; // 패널 안 클릭은 아무 동작도 하지 않는다
      if (scoreDetail.open?.sticky) { closeScore(); scoreDetail.suppressHover = true; } else openScore(scoreRow, true);
      return;
    }
    openDetail(event);
  });
  function openDetail(event: Event) {
    if ((event.target as HTMLElement).closest('.rank-export-button')) return;
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-report-system][data-report-country]');
    if (!button) return;
    const country = button.dataset.reportCountry!, system = button.dataset.reportSystem as SystemKey;
    if (!SYSTEM_KEYS.includes(system) || !findRecord(country, system)) return;
    // 지도 카드 칩이나 보고서 탭 순위를 누르면 지도로 전환해 그 국가 카드를 고정한다. 채팅에는 아무것도 넣지 않는다(보고서 전달은 카드의 첨부 버튼)
    setView('map'); setMode(system); pinCountry(country);
  }
  $('#rankingReport').addEventListener('click', openDetail);
  $('#rankingReport').addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('.rank-export-button')) reportEditor.open(rankingToDoc(seed));
  });
  const rankingReport = $('#rankingReport');
  const showChartSlice = (event: Event) => {
    const slice = (event.target as Element).closest('path[data-chart-name]');
    if (!slice) return;
    const name = rankingReport.querySelector('#chartFocusName');
    const value = rankingReport.querySelector('#chartFocusValue');
    if (name) name.textContent = slice.getAttribute('data-chart-name');
    if (value) value.textContent = slice.getAttribute('data-chart-amount');
  };
  const resetChartSlice = (event: Event) => {
    if (!(event.target as Element).closest('path[data-chart-name]')) return;
    const name = rankingReport.querySelector('#chartFocusName');
    const value = rankingReport.querySelector('#chartFocusValue');
    if (name) name.textContent = 'TOP 5 합계';
    if (value) value.textContent = rankingReport.querySelector('.rank-revenue-center')?.getAttribute('data-total') ?? '';
  };
  rankingReport.addEventListener('pointerover', showChartSlice);
  rankingReport.addEventListener('focusin', showChartSlice);
  rankingReport.addEventListener('pointerout', resetChartSlice);
  rankingReport.addEventListener('focusout', resetChartSlice);
  async function showPlotlyTimeline() {
    const node = rankingReport.querySelector<HTMLElement>('#rankTimelinePlot');
    if (!node || rankingReport.hidden) return;
    try {
      await mountTimeline(node, seed, selectedTimeline, range => { selectedTimeline = range; });
    } catch (error) {
      console.error(error);
      if (node.isConnected) node.textContent = '그래프를 불러오지 못했습니다.';
    }
  }
  const canvas = globe.renderer.domElement;
  canvas.tabIndex = -1;
  canvas.setAttribute('aria-label', '지구본 지도');
  document.addEventListener('keydown', event => {
    if (document.body.classList.contains('re-locked')) return;
    const action = shortcutAction({ key: event.key, code: event.code, isComposing: event.isComposing, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey }, items.length);
    if (action === 'escape') {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!searchOverlay.hidden) { closeSearch(); return; }
      unpin(); chat.dispatch([{ type: 'set_chat_open', open: false }]);
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      canvas.focus();
      return;
    }
    if (action === 'search') { event.preventDefault(); event.stopImmediatePropagation(); chat.dispatch([{ type: 'open_search' }]); return; }
    if (action === 'settings') { event.preventDefault(); event.stopImmediatePropagation(); chat.dispatch([{ type: 'open_settings', toggle: true }]); return; }
    if (isEditableTarget(event.target)) return;
    if (!action) return;
    event.preventDefault();
    if (typeof action === 'object') chat.dispatch([{ type: 'set_mode', system: (items[action.index][0] || null) as SystemKey | null }]);
    else if (action === 'chat') chat.dispatch([{ type: 'set_chat_open', open: true }]);
    else if (action === 'report') chat.dispatch([{ type: 'set_app_view', view: 'report' }]);
    else if (action === 'map') chat.dispatch([{ type: 'set_app_view', view: 'map' }, { type: 'toggle_map_mode', flat: true }]);
    else if (action === 'globe') chat.dispatch([{ type: 'set_app_view', view: 'map' }, { type: 'toggle_map_mode', flat: false }]);
  }, true);
  applyMode();
  void loadScores();
  (window as any).__app = { setMode, toggleMap, focusCountry, state, getAppContext: chat.getAppContext };
  document.body.classList.add('ready');
  const checkData = async () => {
    if (document.hidden) return;
    try {
      const result = await fetch('/api/data/version', { cache: 'no-store' });
      const version = await result.json();
      if (String(version.revision) !== dataVersion) { await refreshData(); for (const [id, c] of Object.entries(seed.countries)) names[id] = c.ko; applyMode(); void loadScores(); }
    } catch { /* 다음 활성화, 주기 확인에서 재시도 */ }
  };
  setInterval(checkData, 5000);
  addEventListener('focus', checkData);
}

/** 펼친 종합 점수 행 아래에 넣을 패널. 캐시에 없으면 그때 불러온다(국가, 체계별 1회, 점수 재로딩 시 무효화) */
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
    detail = response.ok && Array.isArray(body.components) ? { status: 'ok', data: body } : { status: 'error', message: `항목별 점수를 불러오지 못했습니다${body?.error ? ` (${String(body.error)})` : ''}` };
  } catch { detail = { status: 'error', message: '항목별 점수를 불러오지 못했습니다. 연결을 확인하세요' }; }
  if (generation !== scoreDetail.generation) return; // 그 사이 점수, 모드, 자료 버전이 바뀌었다
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
    const chips = recs.map(r => { const f = computeForecast(r); return `<button type="button" class="chip" data-report-country="${esc(id)}" data-report-system="${r.system}" aria-label="${name} ${esc(f.systemKo)} 지도 카드 보기" title="${esc(f.systemKo)} 지도로 전환하고 지도 카드 보기"><i style="background:${SYSTEM_COLOR[r.system]}"></i>${esc(f.systemKo)}</button>`; }).join('');
    const best = bestWeapons.get(id);
    const forecast = best ? computeForecast(findRecord(id, best.system)!) : null;
    return `<div class="th">${esc(meta?.flag ?? '')} ${name}</div>${best ? `<table><tr><th>최고 수주 가능성</th><td><i class="weapon-dot" style="background:${SYSTEM_COLOR[best.system]}"></i>${esc(seed.systems[best.system].ko)} (${best.score}점)</td></tr><tr><th>교체 시기</th><td>${timingLabel(forecast!.remaining)}</td></tr></table>` : '<p class="map-note">비교 가능한 수주 종합 점수를 확인 중이거나 수출 제외 대상입니다.</p>'}<div class="chips">${chips}</div>`;
  }
  const rec = findRecord(id, mode);
  const sysKo = esc(seed.systems[mode].ko);
  const sc = scores.get(scoreKey(mode, id));
  const style = mapStyles.get(id);
  if (scoreDetail.open && (scoreDetail.open.country !== id || scoreDetail.open.system !== mode)) scoreDetail.open = null;
  // 종합 점수 행: 누르거나(고정 카드에서) 커서를 올리면 바로 아래에 항목별 점수를 펼친다
  const scoreRow = sc ? scoreRowHtml(id, mode, sc.grey ? `제외됨 (${esc((sc.gate || '').slice(0, 60))})` : `${sc.score}/100`, !!scoreDetail.open) + scoreSlotHtml(id, mode) : '';
  if (!rec || style?.coverage === 'missing') {
    const neighbors = style?.neighbors ?? [];
    const rows: [string, string][] = [
      ['인접국 영향 점수', style?.hatched ? `${style.referenceScore.toFixed(1)}점, ${style.referenceRank}위` : '평가 대상 아님'],
      ['이 무기체계 자료가 있는 육상 인접국', neighbors.length ? `${neighbors.map(n => esc(names[n] ?? n)).join(', ')} (${neighbors.length}개국)` : '없음'],
      ['인접국들의 예상 사업 금액 합계', `${fmtKrwRange(style?.neighborAmount ?? null)}${style?.neighborAmount ? ' <span class="pred">예측</span>' : ''}`],
    ];
    return `<div class="th">${esc(meta?.flag ?? '')} ${name} ${sysKo}<span class="badge" style="--c:${style?.hatched ? SYSTEM_COLOR[mode] : '#8b98ad'}">${style?.hatched ? '인접국 영향' : '자료 없음'}</span></div>
      <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}${scoreRow}</table>
      <p class="map-note">${neighbors.length ? '인접국 영향 점수는 이 무기체계 자료가 있는 육상 인접국의 수(50점)와 그 인접국들의 예상 사업 금액 합계(50점)를 더해 계산합니다.' : '이 국가에는 이 무기체계 자료가 있는 육상 인접국이 없습니다.'} 이 국가가 직접 보유한 장비와 교체 일정은 아직 확인되지 않았습니다.</p>`;
  }
  const f = computeForecast(rec);
  const cur = f.current;
  const be = (b: { est: string[] }, k: string) => b.est.includes(k);
  const rows: [string, string][] = [];
  rows.push(['현재 주력', cur ? `${esc(cur.model)} ${cur.qty == null ? '수량 미확인' : `${cur.qty.toLocaleString()}${esc(f.unit)}`}${est(be(cur, 'qty'))}, ${cur.introYear == null ? '도입 연도 미확인' : `${cur.introYear}년 도입`}${est(be(cur, 'introYear'))}` : '보유 장비 조사 필요']);
  if (cur) rows.push(['설계 수명', `${cur.life}년${est(f.lifeEst)}${cur.ext ? ` + MRO ${cur.ext}년` : ''}${cur.year == null ? ', 도입 연도 확인 필요' : ` → ${cur.year}년`}`]);
  rows.push(['교체 예상', f.window ? `${fmtWin(f)} <span class="pred">예측</span>${f.status === 'next' ? ' (다음 교체 주기)' : f.status === 'plan' ? ' (사업 계획 기준)' : ''}` : '도입 연도와 사업 일정 조사 필요']);
  // 진행 중, 선정 전 사업: 공급자가 정해지면 교체 수요 충족(사업 기회 아님), 선정 전이면 사업 기회 유지
  if (f.program && f.program.id !== 'awarded') rows.push(['진행 사업', `${esc(f.program.reason.replace(/^[^:]*:\s*/, ''))}, ${esc(f.program.stageKo)}${f.program.open ? ', 아직 사업 기회 있음' : ''}`]);
  const mro = rec.mro?.[rec.mro.length - 1];
  if (mro) rows.push(['최근 MRO', `${mro.year}${est(!!mro.est?.includes('year'))} ${esc(mro.text)}`]);
  if (rec.awarded && cur) rows.push(['최근 계약', `${rec.awarded.year} ${esc(rec.awarded.text)}`]);
  if (rec.plan) rows.push(['사업 계획', esc(rec.plan.text)]);
  if (f.status !== 'none') rows.push(['예상 사업', `${fmtQtyRange(f.qty, esc(f.unit))}, ${fmtKrwRange(f.krw)} <span class="pred">예측</span>${est(f.krwEst)}`]);
  rows.push(['신뢰도', `${f.confidence} (근거 ${f.nSources}건)`]);
  if (style?.coverage === 'partial') rows.push(['자료 상태', f.remaining == null ? '자료 일부만 있음, 시기 미확인' : '자료 일부']);
  const links = f.sources.slice(0, 4).map((s, i) => `<a href="${safeHref(s.u)}" target="_blank" rel="noopener" title="${esc(s.t)}">${i + 1}. ${esc(host(s.u))}</a>`).join('');
  return `<div class="th">${esc(meta.flag)} ${name} ${sysKo}<span class="badge" style="--c:${SYSTEM_COLOR[mode]}">${style?.coverage === 'partial' ? '자료 일부' : timingLabel(f.remaining)}</span><button type="button" class="tip-attach" data-attach-country="${esc(id)}" data-attach-system="${mode}" aria-label="채팅에 국가 보고서 첨부" title="채팅에 국가 보고서 첨부"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m8 12.5 6.8-6.8a4 4 0 0 1 5.7 5.7l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="tip-export" data-export-country="${esc(id)}" data-export-system="${mode}" aria-label="최신 자료를 조사해 Word 보고서 내보내기" title="최신 공개 자료를 다시 조사해 AI가 Word 보고서를 작성합니다"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 3h8l4 4v5M14 3v5h5M8 12h8M8 15h8M8 18h5M17 15v6m-3-3 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}${scoreRow}</table>
    <div class="src">${links}${f.sources.length > 4 ? `<span>+${f.sources.length - 4}</span>` : ''}</div>`;
}

boot().catch(e => { console.error(e); document.body.classList.add('ready'); document.body.insertAdjacentHTML('beforeend', `<div class="fatal">${esc(String(e))}</div>`); });
