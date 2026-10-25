import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { countryCatalog, catalogCountry } from '../shared/countries';
import { resolveCountry } from '../shared/data';
import { Repository, repository, now } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut } from '../server/agent';
import { app } from '../server/app';
import { procurementCoverage } from '../shared/completeness';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const tool = (name: string, args: Record<string, unknown>): Promise<any> => runTool(name, args, newOut());
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-country-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
  await repo.data();
  const c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
  return { repo, controller, ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {} } };
}

describe('챗봇의 국가 등록', () => {
  it('사업 설명만 있는 체계는 등록되어도 조사 완료로 보지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const data = await f.repo.data();
      const record = { id: 'KOR-sph', country: 'KOR', system: 'sph' as const, batches: [], src: [], projects: [{ id: 'K9-project', buyer: 'KOR', supplier: 'KOR', stage: 'delivery' as const, text: '전력화 사업 설명', src: [] }] };
      const coverage = procurementCoverage(record, data, 'sph');
      expect(coverage.status).toBe('partial'); expect(coverage.current).toBeNull(); expect(coverage.window).toBeNull();
      expect(coverage.missing).toContain('현재 운용 장비(model, 운용 상태)');
      const partial = procurementCoverage({ ...record, batches: [{ model: '구형 장비', introYear: 1980, qty: 100, src: [] }, { model: '신형 장비', introYear: 2020, qty: null, primary: true, src: [] }] }, data, 'sph');
      expect(partial.window).not.toBeNull(); expect(partial.status).toBe('partial'); expect(partial.missing).toContain('일부 현역 장비의 보유 수량');
      expect(await tool('get_country_data_status', { country: '대한민국' })).toMatchObject({ complete: false });
      expect(await tool('add_country', { country: '대한민국' })).toMatchObject({ researchRequired: true });
    }); } finally { await f.repo.close(); }
  });
  it('미등록 국가를 한국어·영문·코드로 해석하고 긴 국가명의 부분 일치를 구분한다', () => {
    for (const name of ['독일', 'Germany', 'DEU', 'de']) expect(resolveCountry(name)).toBe('DEU');
    for (const name of ['튀르키예', '터키', 'Türkiye']) expect(resolveCountry(name)).toBe('TUR');
    expect(resolveCountry('기니비사우')).toBe('GNB');
    expect(resolveCountry('중국')).toBe('CHN'); expect(resolveCountry('대만')).toBe('TWN');
    expect(catalogCountry('독')).toBeNull(); expect(resolveCountry('아틀란티스')).toBeNull();
    expect(new Set(countryCatalog.map(c => c.id)).size).toBe(countryCatalog.length);
    for (const c of countryCatalog) { expect(Math.abs(c.lat)).toBeLessThanOrEqual(90); expect(Math.abs(c.lon)).toBeLessThanOrEqual(180); }
  });

  it('조회는 저장하지 않으며 등록은 이력·버전을 갱신하고 재요청은 중복이나 빈 조달 자료를 만들지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const before = await f.repo.data();
      expect(await tool('find_country', { country: '독일' })).toMatchObject({ matches: [{ country: 'DEU', registered: false, systems: [] }] });
      expect(await f.repo.revision()).toBe(1);
      expect(await tool('add_country', { country: '독일' })).toMatchObject({ ok: true, created: true, country: 'DEU', revision: 2, metadata: { ko: '독일', flag: '🇩🇪' }, researchRequired: true });
      expect(await tool('add_country', { country: 'Germany' })).toMatchObject({ ok: true, created: false, revision: 2 });
      const data = await f.repo.data();
      expect(data.countries.DEU.ko).toBe('독일'); expect(data.records).toEqual(before.records);
      expect(await f.repo.all('SELECT * FROM forecasts')).toHaveLength(0);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(1);
      expect(await tool('find_country', { country: 'DEU' })).toMatchObject({ matches: [{ registered: true }] });
      const poland = structuredClone(data.countries.POL);
      expect(await tool('add_country', { country: 'Poland' })).toMatchObject({ created: false, revision: 2 });
      expect((await f.repo.data()).countries.POL).toEqual(poland);
    }); } finally { await f.repo.close(); }
  });

  it('정확하지 않은 이름은 후보만 반환하고 등록하지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      expect((await tool('find_country', { country: '독' })).matches).toContainEqual(expect.objectContaining({ country: 'DEU' }));
      for (const country of ['독', '아틀란티스', '']) expect(await tool('add_country', { country })).toHaveProperty('error');
      expect(await f.repo.revision()).toBe(1);
      expect((await f.repo.data()).countries.DEU).toBeUndefined();
    }); } finally { await f.repo.close(); }
  });

  it('등록 도중 중지하면 국가·이력·버전 변경을 함께 롤백한다', async () => {
    const f = await fixture(), run = f.repo.run.bind(f.repo);
    vi.spyOn(f.repo, 'run').mockImplementation(async (sql, ...args) => {
      const result = await run(sql, ...args);
      if (sql.startsWith('INSERT INTO countries')) f.controller.abort();
      return result;
    });
    try { await executions.run(f.ctx, async () => {
      expect(await tool('add_country', { country: '독일' })).toHaveProperty('error');
      expect(await f.repo.revision()).toBe(1);
      expect(await f.repo.one('SELECT * FROM countries WHERE id=?', 'DEU')).toBeUndefined();
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(0);
      await expect(tool('add_country', { country: '독일' })).rejects.toThrow();
    }); } finally { await f.repo.close(); }
  });

  it.each([true, false])('신규 국가 조사·정제·검증·반영을 끝까지 수행한다 (사전 등록=%s)', async registered => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      if (registered) expect(await tool('add_country', { country: '브라질' })).toMatchObject({ country: 'BRA', created: true });
      const prepared = await tool('research_procurement', { country: '브라질', system: '자주포' });
      expect(prepared.country).toBe('BRA'); expect(prepared.expectedVersion).toBe(0);
      if (!registered) expect(prepared.countryMeta).toMatchObject({ ko: '브라질' });
      const quote = '검증용 가상 자료: 2028년 장비 12문을 도입했다.';
      const source = await tool('save_source', { url: 'https://example.org/country-test', content: quote, kind: 'original', publishedAt: '2026-10-22' });
      const input = {
        record: { country: 'Brazil', system: '자주포', batches: [{ model: '가상 장비', qty: '12문', introYear: '2028년', src: ['country-test'] }], src: ['country-test'] },
        sources: { 'country-test': { ...source, t: '가상 자료', u: 'https://example.org/country-test', y: 2026 } },
        evidence: [{ path: 'batches', sourceId: 'country-test', quote }], reason: '신규 국가 조사 검증', asOf: '2026-10-22',
      };
      const normalized = await tool('normalize_procurement_data', { payload: JSON.stringify(input) });
      expect(normalized.ok).toBe(true);
      expect(await tool('validate_research', { payload: JSON.stringify(normalized.payload) })).toMatchObject({ valid: true });
      expect((await f.repo.data()).records.filter(r => r.country === 'BRA')).toHaveLength(0);
      expect(await tool('apply_research', { payload: JSON.stringify(normalized.payload) })).toMatchObject({ ok: true, version: 1 });
      expect(await tool('query_procurement', { country: '브라질', system: '자주포' })).toMatchObject({ records: [{ country: 'BRA', batches: [{ qty: 12 }] }] });
      expect((await f.repo.data()).countries.BRA.ko).toBe('브라질');
      expect(await f.repo.all('SELECT * FROM forecasts')).toHaveLength(1);
    }); } finally { await f.repo.close(); }
  });
  it('비공개 수량을 null로 반영하고 지도용 조회·보고서·완결성 검사에서 시기와 규모를 분리한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const quote = '가상 검증 자료: 장비 X는 2000년부터 운용했으며 수량은 비공개다.';
      const source = await tool('save_source', { url: 'https://example.org/partial', content: quote, kind: 'original' });
      const normalized = await tool('normalize_procurement_data', { payload: JSON.stringify({
        record: { country: '브라질', system: 'sph', batches: [{ model: '장비 X', introYear: '2000년', qty: '00문', status: 'in_service', src: ['partial'] }], src: ['partial'] },
        sources: { partial: { ...source, t: '가상 자료', u: 'https://example.org/partial', y: 0 } },
        evidence: [{ path: 'batches', sourceId: 'partial', quote }], reason: '비공개 수량 검증', asOf: '2026-10-22',
      }) });
      expect(normalized.ok).toBe(true); expect(normalized.payload.record.batches[0].qty).toBeNull();
      expect(await tool('validate_research', { payload: JSON.stringify(normalized.payload) })).toMatchObject({ valid: true, coverage: { status: 'partial', current: { model: '장비 X' }, window: [2033, 2038], quantity: null } });
      expect(await tool('apply_research', { payload: JSON.stringify(normalized.payload) })).toMatchObject({ ok: true, forecast: { current: { model: '장비 X' }, window: [2033, 2038], qty: null, krw: null } });
      expect(await tool('get_country_data_status', { country: '브라질', system: '자주포' })).toMatchObject({ complete: false, coverage: [{ status: 'partial', missing: ['보유 수량과 사업 수량'] }] });
      expect(await tool('add_country', { country: '브라질' })).toMatchObject({ created: false, researchRequired: true });
      const report = await tool('get_country_analysis', { country: '브라질', system: '자주포' });
      expect(report.analysis.markdown).toContain('수량 미확인'); expect(report.analysis.markdown).not.toContain('0~0');
    }); } finally { await f.repo.close(); }
  });
  it('모델이 양식을 틀리면 실제 보존 원문 메타데이터와 수정 양식을 반환하고 DB에는 쓰지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const saved = await tool('save_source', { url: 'https://example.org/format', content: '장비 X 원문', kind: 'original' });
      const result = await tool('normalize_procurement_data', { payload: JSON.stringify({ record: { country: '브라질', system: 'sph', batches: [{ model: 'X', introYear: 2000, qty: null, est: true }] }, sources: [], evidence: [{ path: saved.filePath, quote: '장비 X 원문' }], reason: '양식 검증', asOf: '2026-10-22' }) });
      expect(result.ok).toBe(false); expect(result.payload).toBeNull();
      expect(result.repair.sourceCandidates[0].source).toMatchObject({ filePath: saved.filePath, hash: saved.hash, collectedAt: saved.collectedAt });
      expect(result.repair.example.record.batches[0].est).toEqual([]);
      expect(result.repair.example.evidence[0].path).toBe('batches');
      expect(await f.repo.revision()).toBe(1);
    }); } finally { await f.repo.close(); }
  });
  it('간단한 장비 도구가 실제 원문으로 부분 자료를 저장하고 위조 인용·상충 수량·검색 요약을 거절한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const quote = '가상 원문: X 장비가 2000년부터 운용 중이며 수량은 미공개다.';
      const saved = await tool('save_source', { url: 'https://example.org/equipment', content: quote, kind: 'original' });
      const args = { country: '브라질', system: 'sph', model: 'X', introYear: 2000, filePath: saved.filePath, quote };
      expect(await tool('save_equipment', args)).toMatchObject({ ok: true, forecast: { current: { model: 'X' }, window: [2033,2038], qty: null } });
      expect(await tool('save_equipment', { ...args, qty: 12 })).toMatchObject({ ok: true, version: 2 });
      expect(await tool('save_equipment', { ...args, qty: 13 })).toHaveProperty('error');
      expect(await tool('save_equipment', { ...args, quote: '원문에 없는 문장' })).toHaveProperty('error');
      const search = await tool('save_source', { url: 'https://example.org/search', content: quote, kind: 'search' });
      expect(await tool('save_equipment', { ...args, filePath: search.filePath })).toHaveProperty('error');
      expect((await f.repo.data()).records.find(r => r.country === 'BRA' && r.system === 'sph')?.batches[0].qty).toBe(12);
    }); } finally { await f.repo.close(); }
  });

  it('실제 채팅 API가 모델의 국가 도구 호출을 실행하고 재접속할 DB와 지도 데이터에 보존한다 (모델 응답은 가상)', async () => {
    let step = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(init.body as string);
      expect(request.tools.some((t: any) => t.name === 'add_country')).toBe(true);
      expect(request.instructions).toContain('나라·국가를 추가');
      const call = (name: string) => ({ type: 'function_call', id: `fc_${step}`, call_id: `c_${step}`, name, arguments: '{"country":"독일"}' });
      const output = ++step === 1 ? [call('find_country')] : step === 2 ? [call('add_country')] : [{ type: 'message', content: [{ type: 'output_text', text: '독일을 등록했습니다. 조달 조사 자료는 아직 없습니다.' }] }];
      if (step === 3) expect(JSON.parse(request.input.filter((i: any) => i.type === 'function_call_output').at(-1).output)).toMatchObject({ ok: true, country: 'DEU' });
      return new Response(JSON.stringify({ output }), { headers: { 'content-type': 'application/json' } });
    }));
    const response = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt', messages: [{ role: 'user', text: '독일을 나라 목록에 추가해줘' }] }) }, { OPENAI_API_KEY: 'test-key' });
    const result = await response.json();
    expect(result.tools).toEqual(['find_country', 'add_country']); expect(result.reply).toContain('등록');
    const mapped = await (await app.request('/api/data')).json();
    expect(mapped.countries.DEU).toMatchObject({ ko: '독일', flag: '🇩🇪' });
    expect(mapped.records.some((r: any) => r.country === 'DEU')).toBe(false);
    const repo = repository(), fresh = new Repository(repo.file, repo.storage);
    try { expect((await fresh.data()).countries.DEU).toEqual(mapped.countries.DEU); } finally { await fresh.close(); }
  });
});
