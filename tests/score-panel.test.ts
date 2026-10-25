import { describe, expect, it } from 'vitest';
import { scorePanelHtml, scoreRowHtml } from '../src/score-panel';
import { computeScore } from '../shared/forecast';
import type { ScoreBreakdown } from '../shared/types';

const base = 2026;
const breakdown = (over: Partial<ScoreBreakdown> = {}): ScoreBreakdown => ({
  ...computeScore({
    country: 'ROU', system: 'sph',
    signals: [{ id: 's1', country: 'ROU', system: 'sph', stage: 'tender', published_at: '2025-05-01', expected_year: 2028, confidence: 0.7 }],
    budgets: [{ country: 'ROU', year: 2023, usd_m: 100, confidence: 1 }, { country: 'ROU', year: 2025, usd_m: 121, gdp_pct: 3, confidence: 1 }],
  }, base),
  ...over,
});

describe('판단 점수 행·항목별 점수 패널', () => {
  it('판단 점수 행은 누를 수 있는 행이고 국가·체계를 담는다', () => {
    const html = scoreRowHtml('ROU', 'sph', '42/100', false);
    expect(html).toContain('class="score-row"');
    expect(html).toContain('data-score-country="ROU"');
    expect(html).toContain('data-score-system="sph"');
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<th>판단 점수</th><td>42/100');
    expect(scoreRowHtml('ROU', 'sph', '42/100', true)).toContain('class="score-row open"');
  });
  it('7개 항목을 순서대로 점수/비중, 비율 막대, 자료 없음, 추정 표시와 함께 보여 준다', () => {
    const b = breakdown();
    b.components[1] = { ...b.components[1], estimated: true, missing: false, points: 5, weight: 20, detail: '가'.repeat(80) };
    const html = scorePanelHtml({ status: 'ok', data: b }, '#ff8800');
    const labels = [...html.matchAll(/<span class="sf-l">([^<]+)/g)].map(m => m[1].trim());
    expect(labels).toEqual(['도입 의사 표명', '노후화', '재정 여력', '주변국 압력', '소모 보충', '경쟁 우위', '접근성']);
    expect(html).toContain('style="--c:#ff8800"');
    expect(html).toContain('10.5 / 20</span><span class="sf-bar"><i style="width:52.5%"></i>'); // 입찰 0.75 × 신뢰도 0.7 × 20
    expect(html).toContain('노후화 <em>추정</em>');
    expect(html).toContain('5.0 / 20</span><span class="sf-bar"><i style="width:25%">');
    expect(html).toContain(`title="${'가'.repeat(80)}"`);
    expect(html).toContain(`>${'가'.repeat(47)}…</span>`);
    const missing = b.components.filter(c => c.missing).length;
    expect(missing).toBeGreaterThan(0);
    expect(html.match(/<span class="sf-miss">자료 없음<\/span>/g)).toHaveLength(missing);
    expect(html).toContain(`항목 합 ${b.subtotal.toFixed(1)}`);
    expect(html).toContain('미판정 ×1');
    expect(html).not.toContain('독자 개발');
    expect(html).toContain(`최종 ${b.score.toFixed(1)}/100`);
  });
  it('등급·독자 개발 계수와 제외 사유를 보여 주고 모든 글자를 이스케이프한다', () => {
    const b = breakdown({ tier: 2, tierFactor: 0.7, domestic: 'development', domesticFactor: 0.8 });
    const html = scorePanelHtml({ status: 'ok', data: b }, '#fff');
    expect(html).toContain('조건부 수출 가능 ×0.7');
    expect(html).toContain('독자 개발 개발 중 ×0.8');
    const grey = breakdown({ gate: { passed: false, reason: '수출 불가: <script>x</script>', evidence: [] }, grey: true, score: 0 });
    grey.components[0] = { ...grey.components[0], label: '<b>도입</b>', detail: '"q" & <i>' };
    const g = scorePanelHtml({ status: 'ok', data: grey }, '#fff');
    expect(g.indexOf('score-gate')).toBeLessThan(g.indexOf('sf-list'));
    expect(g).toContain('제외됨: 수출 불가: &lt;script&gt;x&lt;/script&gt;');
    expect(g).toContain('&lt;b&gt;도입&lt;/b&gt;');
    expect(g).toContain('title="&quot;q&quot; &amp; &lt;i&gt;"');
    expect(g).not.toContain('<script>');
    expect(g).toContain('최종 0 (제외)');
  });
  it('불러오는 중·실패 상태 줄', () => {
    expect(scorePanelHtml({ status: 'loading' }, '#fff')).toContain('불러오는 중');
    expect(scorePanelHtml({ status: 'error', message: '실패 <x>' }, '#fff')).toContain('<p class="score-status error">실패 &lt;x&gt;</p>');
  });
});
