import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Repository, now, repository } from '../server/store';
import { executions } from '../server/execution';
import { researchTool, submitResearch } from '../server/research';
import { upsertRows, selectRows } from '../server/collection';
import { runTool, newOut, TOOL_DEFS } from '../server/agent';
import { app } from '../server/app';
import { reportTool } from '../server/reporting';
import { computeScore, DEFAULT_WEIGHTS } from '../shared/forecast';
import type { ExportTierRow } from '../shared/types';

const tierRow = (country: string, tier: 1 | 2 | 3, system: ExportTierRow['system'] = '*'): Partial<ExportTierRow> => ({ country, system, tier, tier_reasons: { reasons: [{ code: tier === 3 ? 'embargo:UN' : 'clear', text: tier === 3 ? 'UN 안보리 무기 금수: 시험' : '시험', tier, evidence: [] }], facts: { koreanDeliveries: tier === 1 ? 2 : 0 }, approvals: tier === 2 ? ['시험 승인'] : [] }, tier_checked_at: '2026-10-21T00:00:00Z', source_id: 'tier_rules_v1', confidence: 1, collected_at: '2026-10-21T00:00:00Z' });

describe('판단 점수 산식', () => {
  const base = 2026;
  it('도입 의사·재정·주변국·접근성 항목은 비중 × 원점수 × 신뢰도, 등급 계수 적용', () => {
    const input = {
      country: 'ROU', system: 'sph' as const,
      tier: tierRow('ROU', 2) as ExportTierRow,
      signals: [{ id: 's1', country: 'ROU', system: 'sph' as const, stage: 'tender' as const, published_at: '2025-05-01', expected_year: 2028, confidence: 0.7 }],
      budgets: [{ country: 'ROU', year: 2023, usd_m: 100, confidence: 1 }, { country: 'ROU', year: 2024, usd_m: 110, confidence: 1 }, { country: 'ROU', year: 2025, usd_m: 121, gdp_pct: 3, confidence: 1 }],
    };
    const s = computeScore(input, base);
    const c = Object.fromEntries(s.components.map(x => [x.factor, x]));
    expect(c.intent).toMatchObject({ weight: 20, raw: 0.75, confidence: 0.7, points: 10.5, evidence: ['signals:s1'] });
    expect(c.fiscal).toMatchObject({ raw: 1, points: 15 }); // 증가율 10% 이상, GDP 3%
    expect(c.aging.missing).toBe(true);
    expect(s.tierFactor).toBe(0.7);
    expect(s.score).toBe(Math.round((s.subtotal * 0.7) * 10) / 10);
    expect(s.imminenceYear).toBe(2028);
    expect(s.approvals).toEqual(['시험 승인']);
  });
  it('수출 불가·독자 양산은 0점 회색, 개발 단계는 감점, DB 비중이 기본값을 덮어쓴다', () => {
    const signals = [{ id: 's', country: 'X', system: 'sam' as const, stage: 'selection' as const, published_at: '2026-01-01', confidence: 1 }];
    expect(computeScore({ country: 'X', system: 'sam', signals, tier: tierRow('X', 3) as ExportTierRow }, base)).toMatchObject({ score: 0, grey: true, gate: { passed: false } });
    expect(computeScore({ country: 'X', system: 'sam', signals, domestic: { country: 'X', system: 'sam', status: 'production', program: '자체 체계' } }, base)).toMatchObject({ score: 0, grey: true });
    const dev = computeScore({ country: 'X', system: 'sam', signals, domestic: { country: 'X', system: 'sam', status: 'development' } }, base);
    expect(dev).toMatchObject({ grey: false, domesticFactor: 0.8, subtotal: 20, score: 16 });
    expect(computeScore({ country: 'X', system: 'sam', signals, weights: { ...DEFAULT_WEIGHTS, intent: 40 } }, base).subtotal).toBe(40);
  });
});

describe('get_score_breakdown·/api/scores', () => {
  it('MCP·에이전트 도구와 API가 같은 점수를 낸다', async () => {
    expect(TOOL_DEFS.find(t => t.name === 'get_score_breakdown')).toMatchObject({ required: ['country', 'system'] });
    const repo = repository();
    await upsertRows(repo, 'export_tiers', [tierRow('POL', 1), tierRow('EGY', 3)]);
    const out = newOut();
    const r: any = await runTool('get_score_breakdown', { country: '폴란드', system: '자주포' }, out);
    expect(r).toMatchObject({ country: 'POL', system: 'sph', countryKo: '폴란드', tier: 1, grey: false });
    expect(r.components).toHaveLength(7);
    expect(r.components.find((c: any) => c.factor === 'aging').evidence[0]).toMatch(/^records:/); // 보유 이력 표가 비면 기존 기록 예측 사용
    expect(r.evidenceIds).toContain('export_tiers:POL:*');
    expect(await runTool('get_score_breakdown', { country: '없는나라', system: '자주포' }, out)).toMatchObject({ error: expect.any(String) });
    const res = await app.request('/api/scores?system=sph');
    const body = await res.json();
    expect(body.scores.find((s: any) => s.country === 'POL')).toMatchObject({ score: r.score, grey: false });
    expect(body.scores.find((s: any) => s.country === 'EGY')).toMatchObject({ score: 0, grey: true, tier: 3 });
    expect((await app.request('/api/scores')).status).toBe(400);
    expect(r.evidenceMarkdown).toContain('| 항목 | 비중 | 원점수 | 출처 신뢰도 | 점수 | 판단 내용 | 근거 ID |');
    expect(r.evidenceMarkdown).toContain('- 고객등급: 수출 가능 (계수 1)');
  });
  it('GET /api/scores/:country는 get_score_breakdown과 같은 항목별 점수를 돌려준다', async () => {
    const repo = repository();
    await upsertRows(repo, 'export_tiers', [tierRow('POL', 1), tierRow('EGY', 3)]);
    const tool: any = await runTool('get_score_breakdown', { country: 'POL', system: 'sph' }, newOut());
    const res = await app.request('/api/scores/POL?system=sph');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ country: 'POL', system: 'sph', countryKo: '폴란드', score: tool.score, subtotal: tool.subtotal, tierFactor: tool.tierFactor, domesticFactor: tool.domesticFactor, gate: tool.gate });
    expect(body.revision).toEqual(expect.any(Number));
    expect(body.components.map((c: any) => c.factor)).toEqual(['intent', 'aging', 'fiscal', 'neighbor', 'consumption', 'competition', 'access']);
    expect(body.components).toEqual(tool.components);
    const summary = (await (await app.request('/api/scores?system=sph')).json()).scores.find((s: any) => s.country === 'POL');
    expect(summary.score).toBe(body.score);
    // 한국어 국가명·체계 별칭, 제외 국가, 잘못된 입력
    expect(await (await app.request(`/api/scores/${encodeURIComponent('폴란드')}?system=${encodeURIComponent('자주포')}`)).json()).toMatchObject({ country: 'POL', system: 'sph', score: body.score });
    expect(await (await app.request('/api/scores/EGY?system=sph')).json()).toMatchObject({ grey: true, score: 0, gate: { passed: false, reason: expect.stringContaining('수출 불가') } });
    expect((await app.request('/api/scores/POL')).status).toBe(400);
    expect((await app.request(`/api/scores/${encodeURIComponent('없는나라')}?system=sph`)).status).toBe(404);
    // 읽기 전용 GET은 다른 출처에서 와도 기존 규칙대로 허용, 쓰기 메서드는 없다
    expect((await app.request('/api/scores/POL?system=sph', { headers: { origin: 'https://evil.example', host: 'localhost' } })).status).toBe(200);
    expect((await app.request('/api/scores/POL?system=sph', { method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost' } })).status).toBe(403);
  });
  it('prepare_report 작성 자료에 케이스별 근거 표가 들어간다', async () => {
    const repo = repository(), conversation = await repo.createConversation(), runId = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, conversation.id, 'test', 'running', now());
    const packet: any = await executions.run({ repo, conversationId: conversation.id, runId, signal: new AbortController().signal, env: {} } as any, () => reportTool('prepare_report', { country: 'POL', system: 'sph' }));
    expect(packet.templateVersion).toBe('report-templates-v1');
    expect(packet.template.id).toBe('word-country-v1');
    expect(packet.evidenceTables).toHaveLength(1);
    expect(packet.evidenceTables[0]).toMatchObject({ title: '폴란드 자주포 근거 표', columns: ['항목', '비중', '원점수', '출처 신뢰도', '점수', '판단 내용', '근거 ID'] });
    expect(packet.evidenceTables[0].rows).toHaveLength(7);
  });
});

describe('조사 결과 signals 추출', () => {
  it('signalRows는 원문 인용 검사 후 signals 표에 들어가고 forecasts.data에 점수가 남는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-score-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
    const conversation = await repo.createConversation(), runId = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, conversation.id, 'test', 'running', now());
    await executions.run({ repo, conversationId: conversation.id, runId, signal: new AbortController().signal, env: {} } as any, async () => {
      const rec = structuredClone((await repo.data()).records.find(r => r.country === 'ROU' && r.system === 'sph')!);
      const text = '검증용 가상 문서. 루마니아 국방부는 2026년 3월 자주포 추가 도입 입찰을 공고했다. 2029년까지 18문을 인도받는다.';
      const source: any = await researchTool('save_source', { url: 'https://example.org/rou', content: text, kind: 'original', publishedAt: '2026-03-02' });
      rec.signals = [...(rec.signals || []), { year: 2026, text: '추가 도입 입찰', src: ['rou-test'] }];
      rec.src.push('rou-test');
      const signalRows = [{ id: 'rou-sph-2026', stage: 'tender' as const, supplier: '대한민국', quantity: 18, expected_year: 2029, published_at: '2026-03-02', sourceType: 'official' as const, sourceId: 'rou-test', quote: '2026년 3월 자주포 추가 도입 입찰을 공고했다' }];
      const p = { record: rec, signalRows, expectedVersion: 1, reason: '가상 입찰 신호', asOf: '2026-10-21', sources: { 'rou-test': { ...source, status: undefined, t: '검증용', u: 'https://example.org/rou', y: 2026 } }, evidence: [{ path: 'signals', sourceId: 'rou-test', quote: '추가 도입 입찰을 공고했다' }] };
      await expect(submitResearch({ ...p, signalRows: [{ ...signalRows[0], quote: '원문에 없는 문장' }] })).rejects.toThrow(/인용문/);
      expect(await submitResearch(p, { dryRun: true })).toMatchObject({ valid: true, signalRows: 1 });
      expect(await selectRows(repo, 'signals')).toEqual([]);
      const result: any = await submitResearch(p);
      expect(result).toMatchObject({ ok: true, signals: 1 });
      const [row] = await selectRows(repo, 'signals');
      expect(row).toMatchObject({ id: 'research:ROU:sph:rou-sph-2026', country: 'ROU', system: 'sph', stage: 'tender', supplier: 'KOR', confidence: 1, source_id: 'rou-test', url: 'https://example.org/rou', collected_at: source.collectedAt });
      const stored = JSON.parse((await repo.one('SELECT data FROM forecasts ORDER BY id DESC LIMIT 1')).data);
      expect(stored.score.components.find((c: any) => c.factor === 'intent')).toMatchObject({ points: 15, evidence: ['signals:research:ROU:sph:rou-sph-2026'] });
      // 기록 변경 없이 단계만 바뀌면 같은 ID로 갱신
      const next = await submitResearch({ ...p, expectedVersion: 2, signalRows: [{ ...signalRows[0], stage: 'contract' }] });
      expect(next).toMatchObject({ unchanged: true, signals: 1 });
      expect((await selectRows(repo, 'signals')).map(s => s.stage)).toEqual(['contract']);
    });
    await repo.close();
  });
});
