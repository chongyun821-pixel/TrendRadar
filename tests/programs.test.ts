import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { Repository, now } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut, TOOL_DEFS } from '../server/agent';
import { computeForecast, computeScore, needMet, programOf } from '../shared/forecast';
import { searchPrograms, writeReport, forecastBrief } from '../shared/tools';
import { seed } from '../shared/data';
import type { ProgramRecord, Project, SignalRow } from '../shared/types';

const tool = (name: string, args: Record<string, unknown>): Promise<any> => runTool(name, args, newOut());
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-program-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
  await repo.data();
  const c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
  return { repo, ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {} } };
}
const rec = (id: string) => seed.records.find(r => r.id === id)!;
const project = (p: Partial<Project>): Project => ({ id: 'P', buyer: 'VNM', supplier: 'X', stage: 'contract', text: '시험 사업', src: [], ...p });

describe('캐나다 진행 중 사업(마이그레이션 009)', () => {
  it('HIMARS(LRPS(L))는 계약 체결 사업으로 사업 기회가 아니며 후속 주기 = 인도 2029~2034 + 수명 30', () => {
    const f = computeForecast(rec('CAN-mrl'));
    expect(f.program).toMatchObject({ id: 'CAN-LRPS', stage: 'contract', open: false, covers: 1, supplier: 'Lockheed Martin (미국 FMS)', model: 'M142 HIMARS', qty: 26, deliveryStart: 2029, deliveryEnd: 2034 });
    expect(needMet(f)).toBe(true);
    expect(f.status).toBe('next');
    expect(f.window).toEqual([2059, 2064]);
    expect(f.remaining).toBe(33);
    expect(f.calc.join('\n')).toContain('다음 교체 주기(추정) = 인도 2029~2034 + 수명 30 → 2059~2064년');
    expect(f.program!.reason).toContain('2029~2034 (추정) 인도 예정'); // 인도 완료는 완전 운용능력(2034) 기준 추정
  });
  it('CPSP는 TKMS 선정(계약 전)으로 교체 수요 충족, 예비 공급자 한화오션을 이유에 밝히고 기존 계획(2027)을 쓰지 않는다', () => {
    const f = computeForecast(rec('CAN-ssk'));
    expect(f.program).toMatchObject({ id: 'CAN-CPSP', stage: 'selected', open: false, reserve: 'Hanwha Ocean', contractYear: 2027, deliveryStart: 2034 });
    expect(f.status).toBe('next');
    expect(f.window).toEqual([2061, 2067]); // 2034 + 30 = 2064 ±3
    expect(f.program!.reason).toBe('진행 중 사업(공급자 선정(계약 전)): TKMS Type 212CD 12척, 2026 공급자 선정, 2027년까지 계약 예정, 2034년 인도 시작 예정, 예비 공급자 Hanwha Ocean');
    expect(f.calc.some(c => c.includes('진행 사업으로 대체되어 교체 창 계산에 쓰지 않음'))).toBe(true);
  });
  it('보고서·조회 도구가 사업 현황과 "신규 교체 기회 아님"을 쓴다', () => {
    const md = (writeReport({ country: 'CAN', system: 'ssk' }) as { markdown: string }).markdown;
    expect(md).toContain('- 구분: 진행 중 사업(공급자 선정(계약 전)) → 후속 주기');
    expect(md).toContain('- 사업 현황: 진행 중 사업(공급자 선정(계약 전)): TKMS');
    expect(md).toContain('신규 교체 사업 기회 아님');
    expect(md).toContain('예비 공급자 Hanwha Ocean: 협상 결렬 시에만 기회');
    expect(md).toContain('단계 공급자 선정(계약 전)');
    const mrl = (writeReport({ country: 'CAN', system: 'mrl' }) as { markdown: string }).markdown;
    expect(mrl).toContain('후속 주기 2059~2064년(추정)');
    expect(mrl).toContain('canada.ca/en/department-national-defence/news/2026/06/');
    expect(searchPrograms({ country: 'CAN', system: 'mrl' })[0]).toMatchObject({ programs: [{ id: 'CAN-LRPS', stage: '계약 체결', delivery: '2029~2034', estimate: ['deliveryEnd'] }] });
    expect(forecastBrief(computeForecast(rec('CAN-ssk')))).toMatchObject({ status: 'next', opportunity: '교체 수요 충족(진행 사업), 후속 주기만 남음' });
  });
  it('공급자를 고르지 않은 필리핀 잠수함 경쟁은 사업 기회로 남는다', () => {
    const f = computeForecast(rec('PHL-ssk'));
    expect(f.status).toBe('plan'); expect(needMet(f)).toBe(false);
    const tender: ProgramRecord = { ...rec('PHL-ssk'), projects: [project({ id: 'PHL-SSK', buyer: 'PHL', supplier: '', stage: 'tender', contractYear: 2027 })] };
    const g = computeForecast(tender);
    expect(g.status).toBe('plan'); expect(g.window).toEqual(f.window);
    expect(g.program).toMatchObject({ open: true, covers: 0 });
    expect(g.calc.join('\n')).toContain('선정 전 경쟁(입찰 또는 선정 중): 2027 계약 목표 → 공급자 미정, 사업 기회 유지');
    expect((writeReport({ country: 'PHL', system: 'ssk' }, { ...seed, records: seed.records.map(r => (r.id === 'PHL-ssk' ? tender : r)) }) as { markdown: string }).markdown).toContain('공급자 미정(입찰 또는 선정 중) → 사업 기회 유지');
  });
});

describe('진행 사업 일반 규칙', () => {
  const fleet: ProgramRecord = { id: 'T', country: 'VNM', system: 'sph', src: [], batches: [{ model: 'A', introYear: 1985, qty: 100, src: [] }],
    plan: { start: 2027, end: 2030, qty: [100, 100], text: '교체 계획', src: [] } };
  it('계약 사업이 전량 대체하면 계획·노후 교체보다 우선하고 후속 주기를 계산한다', () => {
    const f = computeForecast({ ...fleet, projects: [project({ deliveryStart: 2028, deliveryEnd: 2031, qty: 80 })] });
    expect(f.status).toBe('next'); expect(f.window).toEqual([2063, 2066]); expect(f.qty).toEqual([48, 80]); // 80 × 0.6~1
  });
  it('일부만 대체(covers 0.5)하면 계획이 남는다. 계획이 없으면 남은 노후 수량만 교체 수요다', () => {
    const half = project({ covers: 0.5, deliveryStart: 2028, deliveryEnd: 2031 });
    expect(computeForecast({ ...fleet, projects: [half] }).status).toBe('plan');
    const open = computeForecast({ ...fleet, plan: undefined, projects: [half] });
    expect(open.status).toBe('open'); expect(open.qty).toEqual([30, 50]);
    expect(needMet(open)).toBe(false);
  });
  it('전력 증강(covers 0)은 기존 교체 예측과 독립이다', () => {
    const f = computeForecast({ ...fleet, plan: undefined, projects: [project({ covers: 0, deliveryStart: 2028 })] });
    expect(f.status).toBe('open'); expect(f.qty).toEqual([60, 100]);
  });
  it('인도 연도가 없으면 계약 연도 + 수명 ±3, 취소 사업은 무시한다', () => {
    expect(computeForecast({ ...fleet, projects: [project({ contractYear: 2026 })] }).window).toEqual([2058, 2064]);
    expect(programOf({ ...fleet, projects: [project({ stage: 'cancelled' })] })).toBeNull();
    expect(computeForecast({ ...fleet, projects: [project({ stage: 'cancelled' })] }).status).toBe('plan');
  });
  it('연도가 하나도 없는 계약 사업은 교체 계산에 쓰지 않고 이유를 남긴다', () => {
    const f = computeForecast({ ...fleet, plan: undefined, projects: [project({})] });
    expect(f.status).toBe('open'); expect(needMet(f)).toBe(false);
    expect(f.calc.join('\n')).toContain('계약 연도와 인도 연도 미확인으로 교체 계산에 반영하지 않음');
  });
  it('여러 계약의 covers 합으로 충족을 판단하고 가장 최근 계약을 대표로 쓴다', () => {
    const f = computeForecast({ ...fleet, projects: [project({ id: 'a', covers: 0.5, contractYear: 2020, deliveryStart: 2022, deliveryEnd: 2024 }), project({ id: 'b', covers: 0.5, contractYear: 2025, deliveryStart: 2027, deliveryEnd: 2029 })] });
    expect(f.program).toMatchObject({ id: 'b', covers: 1 }); expect(f.window).toEqual([2062, 2064]); // 2027~2029 + 수명 35
  });
});

describe('진행 사업과 판단 점수', () => {
  const sig = (p: Partial<SignalRow>): SignalRow => ({ id: 's', country: 'CAN', system: 'ssk', stage: 'selection', published_at: '2026-07-06', expected_year: 2027, confidence: 1, ...p } as SignalRow);
  it('공급자가 정해진 사업의 도입 신호는 0점(충족), 노후도는 후속 주기 임박도이며 이유를 남긴다', () => {
    const before = computeScore({ country: 'CAN', system: 'ssk', signals: [sig({ model: 'Type 212CD' })], forecast: { ...computeForecast(rec('CAN-ssk')), program: null, status: 'plan', window: [2027, 2027], remaining: 1 } }, 2026);
    const after = computeScore({ country: 'CAN', system: 'ssk', signals: [sig({ model: 'Type 212CD' })], forecast: computeForecast(rec('CAN-ssk')) }, 2026);
    const c = (s: typeof after, k: string) => s.components.find(x => x.factor === k)!;
    expect(c(before, 'intent').points).toBeGreaterThan(0);
    expect(c(after, 'intent').points).toBe(0);
    expect(c(after, 'intent').detail).toContain('충족');
    expect(c(after, 'aging').detail).toContain('후속 주기 2061~2067년');
    expect(c(after, 'aging').points).toBeLessThan(c(before, 'aging').points);
    expect(after.score).toBeLessThan(before.score);
    expect(after.program).toMatchObject({ id: 'CAN-CPSP' });
  });
  it('공급자 결정 뒤 다른 모델의 새 신호(전력 증강 등)는 따로 센다', () => {
    const s = computeScore({ country: 'CAN', system: 'ssk', signals: [sig({ id: 'n', model: 'Other', stage: 'tender', published_at: '2027-03-01', expected_year: 2030 })], forecast: computeForecast(rec('CAN-ssk')) }, 2026);
    expect(s.components.find(x => x.factor === 'intent')!.points).toBeGreaterThan(0);
  });
});

describe('save_program 도구', () => {
  it('보존 원문으로 선정 전 사업을 등록하고 같은 ID를 계약으로 갱신하며 위조 인용·공급자 없는 계약을 거절한다', async () => {
    expect(TOOL_DEFS.some(d => d.name === 'save_program')).toBe(true);
    const f = await fixture();
    try { await executions.run(f.ctx as any, async () => {
      const quote = '가상 원문: 브라질 해군은 잠수함 2척 입찰을 진행하며 2030년부터 2032년까지 인도받는다.';
      const saved = await tool('save_source', { url: 'https://example.org/program', content: quote, kind: 'original' });
      const args = { country: '브라질', system: '재래식 잠수함', id: 'BRA-SSK', stage: 'tender', text: '잠수함 2척 입찰', qty: 2, filePath: saved.filePath, quote };
      const tender = await tool('save_program', args);
      expect(tender).toMatchObject({ ok: true, version: 1, forecast: { program: { id: 'BRA-SSK', open: true } } });
      const contract = await tool('save_program', { ...args, stage: '계약', supplier: 'Naval Group', contractYear: 2027, deliveryStart: 2030, deliveryEnd: 2032, estimated: 'deliveryEnd' });
      expect(contract).toMatchObject({ ok: true, version: 2, forecast: { status: 'next', window: [2060, 2062], program: { stage: 'contract', open: false, covers: 1 } } });
      const r = (await f.repo.data()).records.find(x => x.country === 'BRA' && x.system === 'ssk')!;
      expect(r.projects).toHaveLength(1);
      expect(r.projects![0]).toMatchObject({ id: 'BRA-SSK', supplier: 'Naval Group', qty: 2, est: ['deliveryEnd'] });
      expect(r.projects![0].src[0]).toMatch(/^program-/);
      expect(await tool('save_program', { ...args, quote: '원문에 없는 문장' })).toHaveProperty('error');
      expect(await tool('save_program', { ...args, id: 'BRA-SSK-2', stage: 'contract' })).toHaveProperty('error');
      expect(await tool('save_program', { ...args, stage: 'awarded' })).toHaveProperty('error');
      const search = await tool('save_source', { url: 'https://example.org/program-search', content: quote, kind: 'search' });
      expect(await tool('save_program', { ...args, filePath: search.filePath })).toHaveProperty('error');
      expect((await f.repo.data()).records.find(x => x.country === 'BRA' && x.system === 'ssk')!.projects).toHaveLength(1);
    }); } finally { await f.repo.close(); }
  });
});

describe('마이그레이션 009', () => {
  it('추가만 하며 다시 실행해도 같은 사업을 중복으로 넣지 않고 팀원이 고친 사업 값을 덮어쓰지 않는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-m9-')), file = join(dir, 'db.sqlite');
    const repo = new Repository(file, dir); await repo.data(); await repo.close();
    const db = new DatabaseSync(file);
    try {
      db.exec("UPDATE records SET data=json_set(data,'$.projects[0].qty',8) WHERE id='CAN-ssk'");
      db.exec(readFileSync(join(process.cwd(), 'db/migrations/009_programs.sql'), 'utf8'));
      const row = db.prepare("SELECT data FROM records WHERE id='CAN-ssk'").get() as { data: string };
      const data = JSON.parse(row.data);
      expect(data.projects).toHaveLength(1); expect(data.projects[0].qty).toBe(8);
      expect(data.src.filter((s: string) => s === 'can_cpsp_pm')).toHaveLength(1);
      expect((db.prepare("SELECT count(*) n FROM records WHERE country='CAN' AND system='mrl'").get() as { n: number }).n).toBe(1);
    } finally { db.close(); }
  });
});
