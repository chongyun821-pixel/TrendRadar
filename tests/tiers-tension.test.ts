import { describe, expect, it } from 'vitest';
import { classifyCountry, classifyTier, type TierFacts } from '../shared/tiers';
import { computeTension, geoFeatures, landNeighbors, rivals, seaNeighbors } from '../shared/tension';
import type { ExportControlRow, PairEventRow } from '../shared/types';

const control = (country: string, regime: string, status: ExportControlRow['status'] = 'active'): ExportControlRow => ({ id: `${regime}:${country}`, country, regime, name: `${regime} 통제`, status });
const facts = (o: Partial<TierFacts> = {}): TierFacts => ({ country: 'POL', controls: [], koreanDeliveries: 3, koreanEvidence: ['signals:a'], conflictParty: false, ...o });

describe('고객 등급 규칙', () => {
  it('제재·금수 없고 한국산 인도 이력이 있으면 1세계', () => {
    const r = classifyTier(facts());
    expect(r.tier).toBe(1);
    expect(r.record.reasons[0]).toMatchObject({ code: 'clear', evidence: ['signals:a'] });
  });
  it('UN·EU·한국 통제는 3세계, 해제된 금수는 무시', () => {
    expect(classifyTier(facts({ country: 'PRK', controls: [control('PRK', 'UN')] })).tier).toBe(3);
    expect(classifyTier(facts({ country: 'RUS', controls: [control('RUS', 'KR')] })).record.reasons[0].evidence).toEqual(['export_controls:KR:RUS']);
    expect(classifyTier(facts({ controls: [control('POL', 'EU', 'lifted')] })).tier).toBe(1);
    expect(classifyTier(facts({ controls: [control('ROU', 'UN')] })).tier).toBe(1); // 다른 나라 행
    const partial = classifyTier(facts({ country: 'LBN', controls: [control('LBN', 'UN', 'partial')] }));
    expect(partial.tier).toBe(2); // 비국가 대상·비구속 금수는 승인 필요
    expect(partial.record.reasons[0].code).toBe('partial:UN');
  });
  it('ITAR (d)(2)는 미국산 부품이 있는 체계만 3세계, 나머지는 2세계', () => {
    const f = facts({ country: 'CYP', controls: [control('CYP', 'US-ITAR-126.1(d)(2)')] });
    const rows = classifyCountry(f, [{ system: 'sph', usItar: false }, { system: 'sam', usItar: true }, { system: 'laser', usItar: null }]);
    expect(rows.map(r => [r.system, r.tier])).toEqual([['*', 2], ['sph', 2], ['sam', 3], ['laser', 2]]);
    expect(rows[3].record.approvals).toContain('laser 체계의 미국산 부품 사용 여부 미확인');
  });
  it('이력·협정 없음, 분쟁 당사국, 미국산 부품은 2세계와 승인 항목', () => {
    const r = classifyTier(facts({ koreanDeliveries: 0, conflictParty: true, conflictEvidence: ['pair_events:ucdp:A:B:2024'] }), { system: 'sam', usItar: true });
    expect(r.tier).toBe(2);
    expect(r.record.reasons.map(x => x.code)).toEqual(['no-history', 'conflict-party', 'us-components']);
    expect(r.record.approvals).toHaveLength(3);
    expect(classifyTier(facts({ koreanDeliveries: 0, defenseAgreement: true })).tier).toBe(1);
  });
});

const square = (id: string, x: number, y: number, s = 1) => ({ id, polygons: [[[[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]]] });
describe('인접국과 긴장도', () => {
  it('공유 꼭짓점 2개 이상이면 육상, 가까운 바다 건너면 해상 인접', () => {
    const f = [square('AAA', 0, 0), square('BBB', 1, 0), square('CCC', 1, 1), square('DDD', 4, 0), square('KAZ', 0, 2)];
    expect(landNeighbors(f).map(p => p.join('-')).sort()).toEqual(['AAA-BBB', 'BBB-CCC']); // AAA-CCC는 한 점만 닿음
    const sea = seaNeighbors(f, 250).map(s => s.pair.join('-'));
    expect(sea).toContain('AAA-CCC');
    expect(sea).toContain('BBB-DDD'); // 약 222km
    expect(sea.some(p => p.includes('KAZ'))).toBe(false); // 내륙국
    expect(geoFeatures({ features: [{ properties: { ADM0_A3: 'KOR' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]] } }] })[0].polygons).toHaveLength(1);
  });
  it('GDELT 상위 적대국은 경쟁국으로 추가', () => {
    const ev = (country: string, counterpart: string, events: number, period = '2025-01'): PairEventRow => ({ source: 'gdelt', country, counterpart, period, events });
    expect(rivals([ev('IND', 'PAK', 900), ev('PAK', 'IND', 300), ev('IND', 'NPL', 10)], 3, 50)).toEqual([['IND', 'PAK']]);
    expect(rivals([ev('IND', 'PAK', 900, '2018-01')], 3, 50, '2021-01')).toEqual([]);
  });
  it('긴장도는 충돌·이벤트·군비·영토 가중합이며 동맹이면 30% 감산', () => {
    const events: PairEventRow[] = [
      { source: 'ucdp', country: 'IND', counterpart: 'PAK', period: '2025', fatalities: 999, confidence: 1 },
      { source: 'gdelt', country: 'IND', counterpart: 'PAK', period: '2025-06', events: 5000, goldstein: -10, confidence: 0.4 },
      { source: 'gdelt', country: 'IND', counterpart: 'PAK', period: '2023-06', events: 999999, goldstein: -10 }, // 12개월 밖
    ];
    const disputes = [{ a: 'PAK', b: 'IND', name: '카슈미르', intensity: 1 }];
    const t = computeTension({ country: 'IND', neighbor: 'PAK', base: 2025, events, budgets: [], signals: [], disputes, alliances: [] });
    expect(t.components.conflict.points).toBe(35);
    expect(t.components.events.points).toBe(25);
    expect(t.components.events.hostileEvents12m).toBe(5000);
    expect(t.components.territory).toMatchObject({ points: 20, dispute: '카슈미르' });
    expect(t.tension).toBe(80);
    expect(t.confidence).toBe(0.4);
    const allied = computeTension({ country: 'IND', neighbor: 'PAK', base: 2025, events, budgets: [], signals: [], disputes, alliances: [{ name: 'X', members: ['IND', 'PAK'] }] });
    expect(allied.tension).toBe(56);
    expect(allied.components.alliance).toMatchObject({ name: 'X', before: 80 });
    const calm = computeTension({ country: 'FIN', neighbor: 'SWE', base: 2025, events: [], budgets: [], signals: [], disputes: [], alliances: [] });
    expect(calm.tension).toBe(0);
  });
});
