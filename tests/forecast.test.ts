import { describe, it, expect, vi } from 'vitest';
import { replacementYear, categoryOf, imminenceScore, confidenceOf, sizeNorm, computeForecast, allForecasts } from '../shared/forecast';
import { seed, resolveCountry, resolveSystem } from '../shared/data';
import { writeReport } from '../shared/tools';
import type { ProgramRecord } from '../shared/types';

describe('forecast basics', () => {
  it('교체 시점 = 도입 + 수명 + MRO', () => { expect(replacementYear(1990, 35, 10)).toBe(2035); expect(replacementYear(2000, 30)).toBe(2030); });
  it('임박도 색 경계', () => {
    expect(categoryOf(0)).toBe('red'); expect(categoryOf(2)).toBe('red'); expect(categoryOf(3)).toBe('orange');
    expect(categoryOf(5)).toBe('orange'); expect(categoryOf(6)).toBe('yellow'); expect(categoryOf(10)).toBe('yellow');
    expect(categoryOf(11)).toBe('blue'); expect(categoryOf(null)).toBe('gray');
  });
  it('임박도 점수는 남은 기간이 짧을수록 높다', () => { expect(imminenceScore(0)).toBeGreaterThan(imminenceScore(5)); expect(imminenceScore(0, 1, 3)).toBe(100); });
  it('신뢰도', () => { expect(confidenceOf(4, 2026, 0, 2026)).toBe('상'); expect(confidenceOf(2, 2026, 3, 2026)).toBe('중'); expect(confidenceOf(1, 2015, 6, 2026)).toBe('하'); });
  it('규모 로그 스케일 0..1', () => { expect(sizeNorm([100, 100])).toBe(0); expect(sizeNorm([1e6, 1e6])).toBe(1); expect(sizeNorm([0, 0])).toBe(0); });
});

describe('computeForecast', () => {
  const rec: ProgramRecord = { id: 'T', country: 'VNM', system: 'sph', src: ['vnm_list'],
    batches: [{ model: 'A', introYear: 1980, qty: 100, src: [] }, { model: 'B', introYear: 2000, qty: 50, lifeExt: 10, src: [] }] };
  it('경과한 배치는 기준 연도부터 창을 연다, 8년 밖 배치는 다음 주기', () => {
    const f = computeForecast(rec);
    expect(f.status).toBe('open');
    expect(f.window![0]).toBe(2026); // 1980+35 = 2015 → 이미 경과
    expect(f.qty).toEqual([60, 100]); // B(2045)는 제외, 100 × 0.6~1.0
    expect(f.krw[0]).toBe(60 * seed.systems.sph.unitCost[0]);
    expect(f.category).toBe('red');
  });
  it('계약 완료 시 후속 주기(인도 완료 + 수명)', () => {
    const f = computeForecast({ ...rec, awarded: { year: 2024, text: 'x', qty: 40, deliveryEnd: 2030, covers: 1, src: [] } });
    expect(f.status).toBe('next'); expect(f.window).toEqual([2062, 2068]); expect(f.category).toBe('blue');
  });
  it('공개 계획이 있으면 계획을 따른다', () => {
    const f = computeForecast({ ...rec, plan: { start: 2027, end: 2028, qty: [8, 12], text: 'p', src: [] } });
    expect(f.status).toBe('plan'); expect(f.qty).toEqual([8, 12]); expect(f.remaining).toBe(1);
  });
  it('기준 연도는 시계가 아니라 meta.baseYear 하나만 따른다', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
      expect(seed.meta.baseYear).toBe(2026);
      expect(computeForecast(rec).window![0]).toBe(2026);
      const report = writeReport({ country: '베트남', system: '자주포' });
      expect('markdown' in report && report.markdown).toContain('기준 연도 2026');
    } finally { vi.useRealTimers(); }
    const later = { ...JSON.parse(JSON.stringify(seed)), meta: { ...seed.meta, baseYear: 2030 } };
    expect(computeForecast(rec, later).window![0]).toBe(2030);
    const report = writeReport({ country: '베트남', system: '자주포' }, later);
    expect('markdown' in report && report.markdown).toContain('기준 연도 2030');
  });
  it('같은 URL의 새 수집 버전을 사용하고 중복 근거는 한 번만 셈', () => {
    const data = JSON.parse(JSON.stringify(seed));
    expect(data.records.length).toBe(seed.records.length);
    data.sources = {
      old: { t: '이전', u: 'https://example.org/test', y: 2020 },
      fresh: { t: '새 자료', u: 'https://example.org/test', y: 2026, collectedAt: '2026-10-16T00:00:00Z', hash: 'test-hash' },
      copied: { t: '복사본', u: 'https://example.org/copied', y: 2026, hash: 'test-hash' },
    };
    const f = computeForecast({ ...rec, src: ['old','fresh','copied'], batches: rec.batches.map(b => ({ ...b, src: [] })) }, data);
    expect(f.nSources).toBe(1); expect(f.latestSource).toBe(2026); expect(f.sources[0].t).toBe('새 자료');
  });
  it('시드 데이터 전체가 계산되고 모든 출처 id가 존재', () => {
    const fs = allForecasts(); expect(fs.length).toBe(seed.records.length);
    for (const r of seed.records) for (const id of [...r.src, ...r.batches.flatMap(b => b.src)]) expect(seed.sources[id], id).toBeTruthy();
    for (const f of fs) { expect(f.qty[0]).toBeLessThanOrEqual(f.qty[1]); expect(f.krw[0]).toBeLessThanOrEqual(f.krw[1]); }
  });
});

describe('lookup & report', () => {
  it('국가·체계 이름 해석', () => { expect(resolveCountry('폴란드')).toBe('POL'); expect(resolveCountry('Poland')).toBe('POL'); expect(resolveSystem('재래식 잠수함')).toBe('ssk'); expect(resolveSystem('천무')).toBe('mrl'); });
  it('보고서 6개 절', () => {
    const r = writeReport({ country: '베트남', system: '자주포' });
    expect('markdown' in r).toBe(true);
    if ('markdown' in r) for (const h of ['요약', '현재 보유', '수명·MRO', '예측 근거', '한화 기회', '출처']) expect(r.markdown).toContain(h);
  });
});
