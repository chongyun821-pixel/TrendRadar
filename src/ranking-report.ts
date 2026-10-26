import { allForecasts, fmtKrw, fmtKrwRange, fmtQtyRange } from '../shared/forecast';
import type { Forecast, Seed, SystemKey } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { esc } from './md';
import { SYSTEM_COLOR } from './map-style';
import { countryName } from '../shared/country-name';

import { rankByWindow, revenueMix } from '../shared/report-ranking';
export { rankByWindow, revenueMix, annualRevenue } from '../shared/report-ranking';
export type { RevenueSlice, AnnualRevenue } from '../shared/report-ranking';

/** Rank countries by the midpoint sum of the same TOP 3 opportunities shown in each card. */
export function rankCountriesByRevenue(forecasts: Forecast[], data: Seed) {
  return [...new Set(forecasts.map(f => f.country))].map(country => {
    const rows = rankByWindow(forecasts.filter(f => f.country === country), 3);
    const revenue = rows.reduce((sum, f) => sum + (f.krw ? (f.krw[0] + f.krw[1]) / 2 : 0), 0);
    return { country, rows, revenue };
  }).filter(entry => entry.rows.length).sort((a, b) => b.revenue - a.revenue
    || countryName(a.country, data).localeCompare(countryName(b.country, data), 'ko'));
}

function renderAnnualChart(): string {
  return `<div class="rank-timeline-panel"><div class="rank-timeline-head"><h3>연도별 예상 수주액</h3><small class="rank-cohort-note">고정 TOP 5 사업의 예상 기간 밖 연도는 0원으로 표시합니다.</small></div><div id="rankTimelinePlot" class="rank-plotly" aria-label="무기체계별 연간 예상 수주액 그래프"></div></div>`;
}

function donutPath(start: number, end: number): string {
  const cx = 175, cy = 175, outer = 151, inner = 86;
  const point = (radius: number, angle: number) => `${(cx + radius * Math.cos(angle)).toFixed(3)} ${(cy + radius * Math.sin(angle)).toFixed(3)}`;
  if (end - start >= Math.PI * 2 - 1e-9) {
    const middle = start + Math.PI;
    return `M ${point(outer, start)} A ${outer} ${outer} 0 1 1 ${point(outer, middle)} A ${outer} ${outer} 0 1 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 1 0 ${point(inner, middle)} A ${inner} ${inner} 0 1 0 ${point(inner, start)} Z`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(outer, start)} A ${outer} ${outer} 0 ${large} 1 ${point(outer, end)} L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)} Z`;
}

function renderRevenueChart(forecasts: Forecast[], data: Seed): string {
  const { slices } = revenueMix(forecasts, data);
  const total = slices.reduce((sum, slice) => sum + slice.midpoint, 0);
  if (!total) return '<div class="rank-card rank-chart-empty">향후 3년간 금액이 확인된 예상 수주 건이 없어 비중을 계산할 수 없습니다.</div>';
  let angle = -Math.PI / 2;
  const paths = slices.map(slice => {
    const end = angle + slice.midpoint / total * Math.PI * 2;
    const name = data.systems[slice.system].ko;
    const percent = (slice.midpoint / total * 100).toFixed(1);
    const label = `${name}: ${percent}%, 예상 수주액 ${fmtKrwRange([slice.low, slice.high])}`;
    const path = `<path d="${donutPath(angle, end)}" fill="${SYSTEM_COLOR[slice.system]}" stroke="#101a29" stroke-width="2" tabindex="0" data-chart-name="${esc(name)}" data-chart-amount="${esc(fmtKrw(slice.midpoint))} 원" aria-label="${esc(label)}"><title>${esc(label)}</title></path>`;
    angle = end;
    return path;
  }).join('');
  const legend = slices.map(slice => {
    const name = data.systems[slice.system].ko;
    return `<li><span class="rank-legend-swatch" style="background:${SYSTEM_COLOR[slice.system]}"></span><span class="rank-legend-name">${esc(name)}</span><small>${slice.count}개국, 예상 수주액 ${esc(fmtKrwRange([slice.low, slice.high]))}</small><strong>${(slice.midpoint / total * 100).toFixed(1)}%</strong></li>`;
  }).join('');
  return `<div class="rank-revenue-panel"><div class="rank-revenue-visual"><svg class="rank-donut" viewBox="0 0 350 350" role="group" aria-label="예상 수주 매출 구성비">${paths}</svg><div class="rank-revenue-center" data-total="${esc(fmtKrw(total))} 원" aria-live="polite"><span id="chartFocusName">3년 합계</span><strong id="chartFocusValue">${esc(fmtKrw(total))} 원</strong><small>범위 중간값 기준</small></div></div><div class="rank-revenue-detail"><ul>${legend}</ul></div></div>`;
}

function row(f: Forecast, rank: number, label: string): string {
  const planned = f.status === 'plan';
  return `<tr><td class="rank-number">${rank}</td><th scope="row"><button type="button" class="rank-link" data-report-country="${esc(f.country)}" data-report-system="${esc(f.system)}" aria-label="${esc(f.countryKo)} ${esc(f.systemKo)} 지도에서 보기">${esc(label)}</button></th><td>${esc(fmtKrwRange(f.krw))}</td><td>${esc(fmtQtyRange(f.qty, f.unit))}</td><td>${f.window![0]}~${f.window![1]}년 <span class="rank-pred${planned ? ' rank-pred-plan' : ''}">${planned ? '공개 계획' : '예측'}</span><small>신뢰도 ${f.confidence}</small></td></tr>`;
}

function table(rows: Forecast[], heading: string, label: (f: Forecast) => string): string {
  if (!rows.length) return '<p class="rank-empty">예상 시기를 산출할 자료가 없습니다.</p>';
  return `<div class="rank-table-wrap"><table><colgroup><col><col><col><col><col></colgroup><thead><tr><th scope="col">순위</th><th scope="col">${heading}</th><th scope="col">예상 매출액</th><th scope="col">예상 수량</th><th scope="col">예상 시점</th></tr></thead><tbody>${rows.map((f, i) => row(f, i + 1, label(f))).join('')}</tbody></table></div>`;
}

export function renderRankingReport(data: Seed): string {
  const forecasts = allForecasts(null, data);
  const bySystem = SYSTEM_KEYS.filter(system => data.systems[system]).map((system: SystemKey) => {
    const rows = rankByWindow(forecasts.filter(f => f.system === system), 5);
    return `<article class="rank-card"><div class="rank-card-head"><h3>${esc(data.systems[system].ko)}</h3><span>TOP 5</span></div>${table(rows, '국가', f => f.countryKo)}</article>`;
  }).join('');
  const countries = rankCountriesByRevenue(forecasts, data);
  const countryCard = ({ country, rows }: (typeof countries)[number]) => {
    const name = countryName(country, data);
    return `<article class="rank-card"><div class="rank-card-head"><h3>${esc(name)}</h3><span>TOP 3</span></div>${table(rows, '무기', f => f.systemKo)}</article>`;
  };
  const byCountry = countries.slice(0, 6).map(countryCard).join('');
  const moreCountries = countries.slice(6);
  const more = moreCountries.length ? `<details class="rank-more"><summary>더보기 <span>${moreCountries.length}개국</span></summary><div class="rank-grid">${moreCountries.map(countryCard).join('')}</div></details>` : '';
  return `<div class="rank-page"><div class="rank-hero"><h1>예상 수주 전망 보고서</h1><div class="rank-summary"><span>기준 연도 <strong>${data.meta.baseYear}년</strong></span><span>무기체계 <strong>${SYSTEM_KEYS.filter(k => data.systems[k]).length}종</strong></span><span>국가 <strong>${countries.length}개</strong></span></div></div><section class="rank-section"><div class="rank-section-head"><span>01</span><div><h2>예상 수주 매출 구성비</h2><p>3년 내 무기별 TOP 5 예상 수주액 기준</p></div></div>${renderRevenueChart(forecasts, data)}</section><section class="rank-section"><div class="rank-section-head"><span>02</span><div><h2>연도별 예상 수주액 추이</h2><p>무기별 고정 TOP 5 예상 수주액 기준</p></div></div><div id="rankTimelineHost">${renderAnnualChart()}</div></section><section class="rank-section"><div class="rank-section-head"><span>03</span><div><h2>무기별 예상 수주 국가</h2><p>무기체계별 예상 시기 도래 순</p></div></div><div class="rank-grid">${bySystem}</div></section><section class="rank-section"><div class="rank-section-head"><span>04</span><div><h2>국가별 예상 수주 무기</h2><p>국가별 예상 시기 도래 순</p></div></div><div class="rank-grid">${byCountry}</div>${more}</section></div>`;
}
