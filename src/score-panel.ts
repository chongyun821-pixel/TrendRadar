/** 지도 정보 카드의 판단 점수 행과 항목별 점수 패널(순수 HTML 조립). 계산은 서버 scoreCase(shared/forecast.ts computeScore)가 한다. */
import type { ScoreBreakdown } from '../shared/types';
import { tierLabel } from '../shared/tiers';
import { esc } from './md';

export const est = (on: boolean) => (on ? ' <em>추정</em>' : '');

/** 패널 상태: 불러오는 중 · 실패 · 받은 내역 */
export type ScoreDetail = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; data: ScoreBreakdown };

const DETAIL_MAX = 48;
const DOMESTIC_KO = { none: '없음', development: '개발 중', production: '양산' } as const;
const fmt1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const factorText = (n: number) => String(Math.round(n * 100) / 100);
const cut = (s: string, max = DETAIL_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 판단 점수 행. 누르거나 커서를 올리면 항목별 점수를 펼친다 */
export function scoreRowHtml(country: string, system: string, value: string, open: boolean) {
  return `<tr class="score-row${open ? ' open' : ''}" data-score-country="${esc(country)}" data-score-system="${esc(system)}" role="button" tabindex="0" aria-expanded="${open}" title="항목별 점수 보기"><th>판단 점수</th><td>${value}<span class="score-more" aria-hidden="true">▸</span></td></tr>`;
}

/** 항목별 점수 패널(판단 점수 행 바로 아래 표 행) */
export function scorePanelHtml(detail: ScoreDetail, color: string) {
  return `<tr class="score-detail"><td colspan="2"><div class="score-panel" style="--c:${esc(color)}">${scorePanelBody(detail)}</div></td></tr>`;
}

function scorePanelBody(detail: ScoreDetail) {
  if (detail.status === 'loading') return '<p class="score-status">항목별 점수를 불러오는 중…</p>';
  if (detail.status === 'error') return `<p class="score-status error">${esc(detail.message)}</p>`;
  const b = detail.data;
  const gate = b.gate.passed ? '' : `<p class="score-gate">제외 · ${esc(b.gate.reason || '통과 조건 미충족')}</p>`;
  const items = b.components.map(c => {
    const ratio = c.weight > 0 && !c.missing ? Math.max(0, Math.min(1, c.points / c.weight)) : 0;
    const pts = c.missing ? '<span class="sf-miss">자료 없음</span>' : `${fmt1(c.points)} / ${esc(String(c.weight))}`;
    const detailText = c.detail ? `<span class="sf-d" title="${esc(c.detail)}">${esc(cut(c.detail))}</span>` : '';
    return `<li class="sf${c.missing ? ' missing' : ''}"><span class="sf-l">${esc(c.label)}${est(!!c.estimated)}</span><span class="sf-p">${pts}</span><span class="sf-bar"><i style="width:${Math.round(ratio * 1000) / 10}%"></i></span>${detailText}</li>`;
  }).join('');
  const sums = [`항목 합 ${fmt1(b.subtotal)}`, `${esc(tierLabel(b.tier))} ×${factorText(b.tierFactor)}`];
  if (b.domesticFactor !== 1) sums.push(`독자 개발 ${b.domestic ? DOMESTIC_KO[b.domestic] : ''} ×${factorText(b.domesticFactor)}`);
  sums.push(`<b>최종 ${b.gate.passed ? `${fmt1(b.score)}/100` : '0 (제외)'}</b>`);
  return `${gate}<ul class="sf-list">${items}</ul><div class="score-sum">${sums.join(' · ')}</div>`;
}
