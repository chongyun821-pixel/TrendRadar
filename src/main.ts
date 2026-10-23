import './style.css';
import { Globe, type CountryFeature } from './globe';
import { seed, findRecord, setData } from '../shared/data';
import { allForecasts, computeForecast, fmtKrwRange, fmtQtyRange } from '../shared/forecast';
import type { Forecast, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { initChat } from './chat';
import { esc } from './md';
import { landNeighbors } from '../shared/tension';
import { SYSTEM_COLOR, MISSING_RGB, rgbCss, systemTint, timingLabel, leadingWeapons, mapSizes, mapCountryStyles, type CountryMapStyle, type WeaponScore } from './map-style';

const state = { mode: null as SystemKey | null, flat: false, focus: null as string | null, pinned: false };
let mapStyles = new Map<string, CountryMapStyle>();
/** 판단 점수와 수출 제외 사유는 정보 카드에 표시한다. 인접국 참고 점수와는 별도다. */
interface ScoreSummary extends WeaponScore { gate: string | null }
const scores = new Map<string, ScoreSummary>();
let bestWeapons = new Map<string, WeaponScore>();
const scoreKey = (system: SystemKey, country: string) => `${system}:${country}`;
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function boot() {
  let dataVersion = '';
  async function refreshData() {
    const response = await fetch('/api/data', { cache: 'no-store' });
    if (!response.ok) throw new Error('조달 데이터 로드 실패');
    setData(await response.json());
    scores.clear(); bestWeapons.clear();
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
      fs = allForecasts().filter(f => bestWeapons.get(f.country)?.system === f.system);
    }
    globe.setBaseColors(
      new Map([...mapStyles].map(([id, style]) => [id, style.rgb])), true,
      new Set([...mapStyles].filter(([, style]) => style.hatched).map(([id]) => id)),
    );
    const visible = fs.filter(f => f.status !== 'none' && f.krw != null && seed.countries[f.country]);
    const sizes = mapSizes(visible);
    globe.setSpikes(visible.filter(f => (sizes.get(f.country) ?? 0) > 0).map(f => ({ id: f.country, lat: seed.countries[f.country].lat, lon: seed.countries[f.country].lon, color: SYSTEM_COLOR[f.system], size: sizes.get(f.country)! })));
    const scaleLegend = `<span class="sz"><b></b>${state.flat ? '원 지름' : '막대 높이'} · 예상 사업 금액 (로그)</span>`;
    if (state.mode) {
      const mode = state.mode, hue = SYSTEM_COLOR[mode];
      $('#legend').innerHTML = `<strong class="legend-title"><i style="background:${hue}"></i>${esc(seed.systems[mode].ko)}</strong>`
        + ([3, 10, 11] as const).map(years => `<span><i style="background:${rgbCss(systemTint(mode, years))}"></i>${timingLabel(years)} · ${years === 3 ? 100 : years === 10 ? 50 : 20}%</span>`).join('')
        + `<span><i class="hatch" style="--hue:${hue}"></i>빗금 · 인접국 참고</span><span><i style="background:${rgbCss(MISSING_RGB)}"></i>바탕색 · 참고 자료 없음</span>`
        + `<small>빗금 · 같은 체계의 자료 있는 육상 인접국 1개 이상<br>참고 점수 · 인접국 수 50% + 예상 금액 50%</small>${scaleLegend}`;
    } else {
      $('#legend').innerHTML = `<strong class="legend-title">일반 · 수주 판단 점수 최고 무기</strong>`
        + SYSTEM_KEYS.map(system => `<span><i style="background:${SYSTEM_COLOR[system]}"></i>${esc(seed.systems[system].ko)}</span>`).join('')
        + `<small>밝기 · 3년 이내 100% / 10년 이내 50% / 이후 20%<br>판단 점수 미확인·수출 제외 국가는 바탕색</small>${scaleLegend}`;
    }
    if (state.pinned && state.focus) tip.innerHTML = tipHtml(state.focus, names);
  }
  let scoreRequest = 0;
  async function loadScores() {
    const mode = state.mode, request = ++scoreRequest, version = dataVersion;
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
  tip.addEventListener('click', event => {
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
  void loadScores();
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

function fmtWin(f: Forecast) { return f.window ? `${f.window[0]}~${f.window[1]}년` : '—'; }
const est = (on: boolean) => (on ? ' <em>추정</em>' : '');
function host(u: string) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } }
function safeHref(u: string) { try { const url = new URL(u); return ['http:', 'https:'].includes(url.protocol) ? esc(url.href) : '#'; } catch { return '#'; } }

function tipHtml(id: string, names: Record<string, string>) {
  const meta = seed.countries[id]; const name = esc(names[id] ?? id);
  const mode = state.mode;
  if (!mode) {
    const recs = seed.records.filter(r => r.country === id);
    if (!recs.length) return `<div class="th">${esc(meta?.flag ?? '')} ${name}</div>`;
    const chips = recs.map(r => { const f = computeForecast(r); return `<button type="button" class="chip" data-report-country="${esc(id)}" data-report-system="${r.system}" aria-label="${name} ${esc(f.systemKo)} 보고서 보기" title="${esc(f.systemKo)} 지도로 전환하고 보고서 열기"><i style="background:${SYSTEM_COLOR[r.system]}"></i>${esc(f.systemKo)}</button>`; }).join('');
    const best = bestWeapons.get(id);
    const forecast = best ? computeForecast(findRecord(id, best.system)!) : null;
    return `<div class="th">${esc(meta?.flag ?? '')} ${name}</div>${best ? `<table><tr><th>최고 수주 가능성</th><td><i class="weapon-dot" style="background:${SYSTEM_COLOR[best.system]}"></i>${esc(seed.systems[best.system].ko)} · 판단 ${best.score}/100</td></tr><tr><th>교체 시기</th><td>${timingLabel(forecast!.remaining)}</td></tr></table>` : '<p class="map-note">비교 가능한 수주 판단 점수를 확인 중이거나 수출 제외 대상입니다.</p>'}<div class="chips">${chips}</div>`;
  }
  const rec = findRecord(id, mode);
  const sysKo = esc(seed.systems[mode].ko);
  const sc = scores.get(scoreKey(mode, id));
  const style = mapStyles.get(id);
  const scoreRow: [string, string] | null = sc ? ['판단 점수', sc.grey ? `제외 · ${esc((sc.gate || '').slice(0, 60))}` : `${sc.score}/100`] : null;
  if (!rec || style?.coverage === 'missing') {
    const neighbors = style?.neighbors ?? [];
    const rows: [string, string][] = [
      ['인접국 참고 점수', style?.hatched ? `${style.referenceScore.toFixed(1)}/100 · 후보 ${style.referenceRank}위` : '평가 대상 아님'],
      ['자료 있는 인접국', neighbors.length ? `${neighbors.length}개국 · ${neighbors.map(n => esc(names[n] ?? n)).join(' · ')}` : '없음'],
      ['인접국 예상 사업 합계', `${fmtKrwRange(style?.neighborAmount ?? null)}${style?.neighborAmount ? ' <span class="pred">예측</span>' : ''}`],
    ];
    if (scoreRow) rows.push(scoreRow);
    return `<div class="th">${esc(meta?.flag ?? '')} ${name} · ${sysKo}<span class="badge" style="--c:${style?.hatched ? SYSTEM_COLOR[mode] : '#8b98ad'}">${style?.hatched ? '인접국 참고' : '자료 없음'}</span></div>
      <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
      <p class="map-note">${neighbors.length ? '인접국의 수와 확인 가능한 예상 사업 금액을 합산한 참고 점수입니다.' : '이 무기체계의 자료가 있는 육상 인접국이 없습니다.'} 이 국가의 보유 장비나 교체 일정은 확인되지 않았습니다.</p>`;
  }
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
  if (style?.coverage === 'partial') rows.push(['자료 상태', f.remaining == null ? '자료 일부 · 시기 미확인' : '자료 일부']);
  if (scoreRow) rows.push(scoreRow);
  const links = f.sources.slice(0, 4).map((s, i) => `<a href="${safeHref(s.u)}" target="_blank" rel="noopener" title="${esc(s.t)}">${i + 1}. ${esc(host(s.u))}</a>`).join('');
  return `<div class="th">${esc(meta.flag)} ${name} · ${sysKo}<span class="badge" style="--c:${SYSTEM_COLOR[mode]}">${style?.coverage === 'partial' ? '자료 일부' : timingLabel(f.remaining)}</span></div>
    <table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table>
    <div class="src">${links}${f.sources.length > 4 ? `<span>+${f.sources.length - 4}</span>` : ''}</div>`;
}

boot().catch(e => { console.error(e); document.body.classList.add('ready'); document.body.insertAdjacentHTML('beforeend', `<div class="fatal">${esc(String(e))}</div>`); });
