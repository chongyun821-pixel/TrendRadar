// 사용자 결정 반영: 기준 연도 단일화, '최근 3년' 범위, 보유 인도 연도 추정, 근거 없는 긴장도 추정, 수명 출처, 수집기 이름
import { describe, it, expect } from 'vitest';
import { isRecent, recentFrom, recentLabel, recentRange } from '../shared/base-year';
import { computeForecast, computeScore, estimateDelivered, INVENTORY_ESTIMATE } from '../shared/forecast';
import { computeTension, estimateMissingTension, TENSION_ESTIMATE } from '../shared/tension';
import { getLifespan, writeReport } from '../shared/tools';
import { evidenceTable, type ScoredCase } from '../server/scoring';
import { USER_AGENT } from '../server/sources';
import { repository } from '../server/store';
import type { InventoryRow, NeighborRow, SignalRow } from '../shared/types';

const base = 2026;
const sig = (id: string, stage: SignalRow['stage'], published: string | null, extra: Partial<SignalRow> = {}): SignalRow => ({ id, country: 'ROU', system: 'sph', stage, published_at: published, confidence: 1, ...extra });
const scored = (s: ReturnType<typeof computeScore>): ScoredCase => ({ ...s, countryKo: '루마니아', systemKo: '자주포', recordId: null });

describe("'최근 3년' = 기준 연도 포함 4개년", () => {
  it('2023~2026이며 2022는 밖이다', () => {
    expect(recentFrom(base)).toBe(2023);
    expect(recentRange(base)).toBe('2023~2026');
    expect(recentLabel(base)).toBe('2023~2026(기준 연도 포함 4개년)');
    expect(isRecent(2023, base)).toBe(true); expect(isRecent(2022, base)).toBe(false);
  });
  it('도입 의사는 2023년 신호를 반영하고 2022년 신호는 예상 시기가 기준 연도 이후일 때만 반영한다', () => {
    const intent = (signals: SignalRow[]) => computeScore({ country: 'ROU', system: 'sph', signals }, base).components.find(c => c.factor === 'intent')!;
    expect(intent([sig('a', 'tender', '2023-01-05')]).missing).toBe(false);
    const old = intent([sig('b', 'tender', '2022-12-31')]);
    expect(old.missing).toBe(true); expect(old.detail).toContain('2023~2026');
    expect(intent([sig('c', 'tender', '2022-12-31', { expected_year: 2027 })]).missing).toBe(false);
  });
  it('조사 양식과 요구서에 범위가 적혀 있다', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['templates/research-v1.md', 'docs/데이터수집요구서.md']) expect(readFileSync(f, 'utf8')).toContain('2023~2026(기준 연도 포함 4개년)');
  });
});

describe('인도 연도 없는 보유 행 추정', () => {
  const inv = (extra: Partial<InventoryRow> = {}): InventoryRow => ({ id: 'i1', country: 'ROU', system: 'sph', model: 'M109', quantity: 36, confidence: 1, ...extra });
  it('같은 모델 배치 → 계약, 인도 신호 → 기준 연도 − 수명 절반 순서로 추정한다', () => {
    const batches = [{ model: 'M109A5', introYear: 1995, qty: 36, life: 35, ext: 0, year: 2030, est: [] }];
    expect(estimateDelivered(inv(), base, 35, batches)).toEqual({ year: 1995, basis: 'batch' });
    expect(estimateDelivered(inv(), base, 35, [], [sig('s', 'contract', '2008-03-01', { model: 'M109' }), sig('t', 'delivery', '2010-01-01', { model: 'M109' })])).toEqual({ year: 2008, basis: 'signal' });
    expect(estimateDelivered(inv(), base, 35)).toEqual({ year: 2026 - 18, basis: 'default' });
  });
  it('추정 행은 추정으로 표시하고 신뢰도를 낮춘다(실제 인도 연도, 퇴역 연도가 있으면 그대로)', () => {
    const exact = computeScore({ country: 'ROU', system: 'sph', inventory: [inv({ delivered_year: 2000 })], designLife: 35 }, base).components.find(c => c.factor === 'aging')!;
    expect(exact).toMatchObject({ confidence: 1, detail: '최초 퇴역 예상 2035년, 10년 내 교체 대상 36/36' });
    expect(exact.estimated).toBeUndefined();
    const s = computeScore({ country: 'ROU', system: 'sph', inventory: [inv()], designLife: 35 }, base);
    const aging = s.components.find(c => c.factor === 'aging')!;
    expect(aging).toMatchObject({ estimated: true, confidence: INVENTORY_ESTIMATE.default });
    expect(aging.detail).toBe('최초 퇴역 예상 2043년 (추정), 10년 내 교체 대상 0/36, 인도 연도 추정 1건(기본값(수명 중간) 1)');
    const row = evidenceTable(scored(s)).rows.find(r => r[0] === '노후화')!;
    expect(String(row[2])).toContain('(추정)');
    const derived = computeScore({ country: 'ROU', system: 'sph', inventory: [inv({ confidence: 0.7 })], signals: [sig('s', 'contract', '2008-03-01', { model: 'M109' })], designLife: 35 }, base).components.find(c => c.factor === 'aging')!;
    expect(derived.confidence).toBe(0.49); expect(derived.detail).toContain('계약 또는 인도 신호 1');
  });
});

describe('근거 없는 긴장도 추정', () => {
  it('근거가 없으면 신뢰도를 1로 두지 않고 추정 대상으로 표시한다', () => {
    const t = computeTension({ country: 'FIN', neighbor: 'SWE', base, events: [], budgets: [], signals: [], disputes: [], alliances: [] });
    expect(t).toMatchObject({ tension: 0, confidence: null, hasEvidence: false });
  });
  it('두 국가가 들어간 근거 있는 쌍의 중앙값 → 전체 중앙값 → 기본값, 같은 동맹이면 30% 감산, 신뢰도 0.2', () => {
    const row = (country: string, neighbor: string, tension: number, hasEvidence: boolean, components: Record<string, any> = {}) => ({ country, neighbor, tension, hasEvidence, confidence: hasEvidence ? 1 : null, components });
    const rows = [row('FIN', 'RUS', 40, true), row('FIN', 'NOR', 10, true), row('EST', 'LVA', 70, true), row('FIN', 'SWE', 0, false), row('PRT', 'ESP', 0, false, { alliance: { name: 'NATO', discount: 0.3, before: 0 } })];
    const [, , , fin, prt] = estimateMissingTension(rows);
    expect(fin).toMatchObject({ tension: 25, confidence: TENSION_ESTIMATE.CONFIDENCE, components: { estimated: { rule: '두 국가가 들어간 근거 있는 쌍의 중앙값', baseline: 25, pairs: 2 } } });
    expect(prt.tension).toBe(28); // 전체 중앙값 40 × 0.7
    expect(prt.components.estimated.rule).toBe('근거 있는 전체 쌍의 중앙값');
    expect(estimateMissingTension([row('A', 'B', 0, false)])[0]).toMatchObject({ tension: TENSION_ESTIMATE.DEFAULT, components: { estimated: { rule: '기본값' } } });
  });
  it('근거가 있으면 근거 자료의 최소 신뢰도를 쓴다(국방비만 있어도)', () => {
    const t = computeTension({ country: 'FIN', neighbor: 'SWE', base, events: [], signals: [], disputes: [], alliances: [], budgets: [2023, 2024, 2025].map((year, i) => ({ country: 'FIN', year, usd_m: 100 + i * 10, confidence: 0.7 })) });
    expect(t).toMatchObject({ hasEvidence: true, confidence: 0.7 });
  });
  it('종합 점수의 주변국 압력에 추정 표시가 붙는다', () => {
    const n: NeighborRow = { country: 'ROU', neighbor: 'UKR', kind: 'land', tension: 25, components: { estimated: { rule: '기본값' } }, confidence: 0.2 };
    const c = computeScore({ country: 'ROU', system: 'sph', neighbors: [n] }, base).components.find(x => x.factor === 'neighbor')!;
    expect(c).toMatchObject({ estimated: true, confidence: 0.2 });
    expect(c.detail).toContain('긴장도 25 (추정)');
  });
});

describe('설계 수명 추정 표시', () => {
  it('출처가 없으면 추정, systems.lifeSrc 출처가 있으면 추정 아님', async () => {
    const data = JSON.parse(JSON.stringify(await repository().data()));
    const rec = data.records.find((r: any) => r.system === 'sph');
    expect(computeForecast(rec, data).lifeEst).toBe(true);
    const plain = writeReport({ country: rec.country, system: 'sph' }, data);
    expect('markdown' in plain && plain.markdown).toContain('체계 기본값을 적용한 추정치');
    const sourceId = Object.keys(data.sources)[0];
    data.systems.sph.lifeSrc = ['없는-출처'];
    expect(computeForecast(rec, data).lifeEst).toBe(true); // 존재하지 않는 출처는 근거가 아니다
    data.systems.sph.lifeSrc = [sourceId];
    const f = computeForecast(rec, data), before = computeForecast(rec, JSON.parse(JSON.stringify(await repository().data())));
    expect(f.lifeEst).toBe(false); expect(f.estCount).toBe(before.estCount - 1);
    const report = writeReport({ country: rec.country, system: 'sph' }, data);
    expect('markdown' in report && report.markdown).toContain(`근거 자료 ${data.sources[sourceId].t}`);
    expect('markdown' in report && report.markdown).not.toContain('체계 기본값을 적용한 추정치');
    expect(getLifespan({ system: 'sph' }).systems[0].estimate).toBe(true); // 운영 데이터에는 아직 수명 출처가 없다
  });
});

it('원문 수집기 이름은 앱 이름의 ASCII 표기', () => { expect(USER_AGENT).toBe('ProcurementRadar/1.0'); });
