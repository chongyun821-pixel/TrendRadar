import { describe, it, expect, vi } from 'vitest';
import { replacementYear, categoryOf, imminenceScore, confidenceOf, sizeNorm, computeForecast, allForecasts, formatKrw } from '../shared/forecast';
import { seed, resolveCountry, resolveSystem } from '../shared/data';
import { writeReport } from '../shared/tools';
import type { ProgramRecord } from '../shared/types';

describe('forecast basics', () => {
  it('억 원 단위 금액을 공통 규칙으로 반올림한다', () => {
    expect(formatKrw(45321)).toBe('4.5조');
    expect(formatKrw(10000)).toBe('1조');
    expect(formatKrw(9999.8)).toBe('1조');
    expect(formatKrw(333.333)).toBe('333억');
    expect(formatKrw(1234.6)).toBe('1,235억');
    expect(formatKrw(12.345)).toBe('12.3억');
    expect(formatKrw(7.04)).toBe('7억');
    expect(formatKrw(99.96)).toBe('100억');
    expect(formatKrw(-1234.6)).toBe('-1,235억');
    expect(formatKrw(0)).toBe('0억');
  });
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
    expect(f.krw![0]).toBe(60 * seed.systems.sph.unitCost[0]);
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
  it('수량이 비공개여도 장비와 도입 연도로 시기를 계산하고 수량, 금액은 null로 유지한다', () => {
    const f = computeForecast({ ...rec, batches: [{ model: '확인 장비', introYear: 2000, qty: null, src: ['vnm_list'] }] });
    expect(f.current?.model).toBe('확인 장비'); expect(f.window).toEqual([2033, 2038]);
    expect(f.qty).toBeNull(); expect(f.krw).toBeNull(); expect(f.size).toBe(0);
    expect(f.calc.join(' ')).toContain('수량 미확인');
  });
  it('연도가 없으면 장비명만 표시하고 날짜나 0원 사업을 지어내지 않는다', () => {
    const f = computeForecast({ ...rec, batches: [{ model: '연도 미상 장비', introYear: null, qty: 10, src: [] }] });
    expect(f.current?.model).toBe('연도 미상 장비'); expect(f.current?.year).toBeNull();
    expect(f.window).toBeNull(); expect(f.qty).toBeNull(); expect(f.krw).toBeNull();
  });
  it('주력 장비와 가장 오래된 교체 대상을 구분하고 퇴역, 도입 예정 장비는 제외한다', () => {
    const f = computeForecast({ ...rec, batches: [
      { model: '퇴역 장비', introYear: 1970, qty: 9000, status: 'retired', src: [] },
      { model: '도입 예정', introYear: 2030, qty: 3000, status: 'planned', src: [] },
      { model: '구형 운용', introYear: 1980, qty: 100, src: [] },
      { model: '현재 주력', introYear: 2000, qty: null, primary: true, src: [] },
    ] });
    expect(f.current?.model).toBe('현재 주력'); expect(f.window?.[0]).toBe(2026); expect(f.qty).toEqual([60, 100]);
  });
  it('수량 없는 공개 계획도 일정과 미확인 규모를 분리한다', () => {
    const f = computeForecast({ ...rec, plan: { start: 2027, end: 2030, qty: null, text: '수량 미공개 계획', src: [] } });
    expect(f.status).toBe('plan'); expect(f.window).toEqual([2027, 2030]); expect(f.qty).toBeNull(); expect(f.krw).toBeNull();
  });
  it('기준 연도는 시계가 아니라 meta.baseYear 하나만 따른다', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
      expect(seed.meta.baseYear).toBe(2026);
      expect(computeForecast(rec).window![0]).toBe(2026);
      const report = writeReport({ country: '베트남', system: '자주포' });
      expect('markdown' in report && report.markdown).toContain('기준 연도는 2026년');
    } finally { vi.useRealTimers(); }
    const later = { ...JSON.parse(JSON.stringify(seed)), meta: { ...seed.meta, baseYear: 2030 } };
    expect(computeForecast(rec, later).window![0]).toBe(2030);
    const report = writeReport({ country: '베트남', system: '자주포' }, later);
    expect('markdown' in report && report.markdown).toContain('기준 연도는 2030년');
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
    for (const f of fs) { if (f.qty) expect(f.qty[0]).toBeLessThanOrEqual(f.qty[1]); if (f.krw) expect(f.krw[0]).toBeLessThanOrEqual(f.krw[1]); }
  });
});

describe('lookup & report', () => {
  it('국가, 체계 이름 해석', () => { expect(resolveCountry('폴란드')).toBe('POL'); expect(resolveCountry('Poland')).toBe('POL'); expect(resolveSystem('재래식 잠수함')).toBe('ssk'); expect(resolveSystem('천무')).toBe('mrl'); });
  it('보고서 6개 절', () => {
    const r = writeReport({ country: '베트남', system: '자주포' });
    expect('markdown' in r).toBe(true);
    if ('markdown' in r) for (const h of ['요약', '현재 보유', '수명과 MRO', '예측 근거', '한화 기회', '출처']) expect(r.markdown).toContain(h);
  });
  it('시드의 모든 국가, 체계 보고서 문구가 자연스러운 형식과 금칙어 기준을 지킨다', () => {
    for (const rec of seed.records) {
      const result = writeReport({ country: rec.country, system: rec.system });
      expect('markdown' in result, `${rec.country}/${rec.system}`).toBe(true);
      if (!('markdown' in result)) continue;
      const markdown = result.markdown;
      expect(markdown, `${rec.country}/${rec.system}`).not.toContain('\u00b7');
      expect(markdown, `${rec.country}/${rec.system}`).not.toContain('나라');
      expect(markdown, `${rec.country}/${rec.system}`).not.toMatch(/undefined|NaN|null/);
      const proseLines = markdown.split('\n').filter(line => !line.trimStart().startsWith('|') && !/https?:\/\//i.test(line));
      for (const line of proseLines) expect((line.match(/:/g) || []).length, `${rec.country}/${rec.system}: ${line}`).toBeLessThan(2);
      const hasSumnidaEnding = /(?:습니다|합니다)(?:[.!?]|$)/m.test(markdown);
      const hasDaEnding = /다(?:[.!?]|$)/m.test(markdown);
      expect(hasSumnidaEnding && hasDaEnding, `${rec.country}/${rec.system}`).toBe(false);
    }
  });
  it('저장소 확장 자료가 있을 때 해당 보고서 절을 표시하고 비어 있는 절은 만들지 않는다', () => {
    const report = writeReport({ country: '베트남', system: '자주포' }, seed, {
      exportTiers: [{ country: 'VNM', system: 'sph', tier: 2, tier_checked_at: '2026-01-01', tier_reasons: { reasons: [{ text: '공식 수출 승인 검토 대상' }] } } as any],
      exportControls: [{ country: 'VNM', regime: 'UN', name: '제한 조치', status: 'active' } as any],
      budgets: [{ country: 'VNM', year: 2025, usd_m: 1000, gdp_pct: 2.1, yoy_pct: 3 } as any],
      neighbors: [{ country: 'VNM', neighbor: 'CHN', kind: 'land', tension: 0.7 } as any],
      pairEvents: [{ source: 'ucdp', country: 'VNM', counterpart: 'CHN', period: '2025', events: 3, fatalities: 4 } as any],
      signals: [{ country: 'VNM', system: 'sph', stage: 'tender', expected_year: 2027, model: '예시 장비' } as any],
      domestic: [{ country: 'VNM', system: 'sph', status: 'development', program: '국산화 사업' } as any],
      inventory: [{ country: 'VNM', system: 'sph', model: '예시 장비', quantity: 12, supplier: '제조사 A' } as any],
      consumption: [{ user_country: 'VNM', system: 'sph', conflict: '사례', quantity: 2, kind: 'loss' } as any],
      links: [{ system: 'sph', model: '예시 장비', maker: '제조사 A', is_group: false, relation: 'group' } as any],
      capacity: [{ maker: '제조사 A', model: '예시 장비', year: 2026, annual_output: 10, backlog: 20 } as any],
    });
    expect('markdown' in report).toBe(true);
    if ('markdown' in report) {
      for (const heading of ['수출 가능 여부와 사유', '국방 예산과 군사비 추세', '인접국 긴장도와 최근 사건', '조달 신호와 진행 사업 단계', '자체 생산 능력', '보유 장비와 소모 추정', '주요 장비 제조사', '공급사 생산 여력']) expect(report.markdown).toContain(heading);
      expect(report.markdown).not.toContain('\u00b7');
    }
    const offline = writeReport({ country: '베트남', system: '자주포' });
    if ('markdown' in offline) expect(offline.markdown).not.toContain('### 7.');
  });
});
