import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, now } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut, TOOL_DEFS } from '../server/agent';
import { selectRows } from '../server/collection';
import { INGEST_SOURCES } from '../server/ingest/registry';
import { toolActivity } from '../src/chat-status';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures/ingest', name);
const repo = repository();
async function context() {
  const c = await repo.createConversation('수집 도구');
  const runId = randomUUID();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
  const controller = new AbortController();
  return { ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {} }, controller };
}
const call = (ctx: any, name: string, args: Record<string, any>) => executions.run(ctx, () => runTool(name, args, newOut())) as Promise<any>;
/** 주소별 가짜 응답. 등록되지 않은 주소는 404로 돌려 실제 네트워크로 나가지 않게 한다 */
function stubNetwork(routes: Record<string, (init?: RequestInit) => Promise<Response> | Response>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    return hit ? hit[1](init) : new Response('not mocked', { status: 404 });
  });
  return calls;
}
/** 중지 신호가 올 때까지 끝나지 않는 응답(느린 GDELT 흉내) */
const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
afterEach(() => { vi.unstubAllGlobals(); });

describe('수집 채팅 도구', () => {
  it('도구 정의가 공용 목록(지피티·네모트론·MCP)에 있고 상태 문구가 있다', () => {
    const names = TOOL_DEFS.map(t => t.name);
    for (const n of ['list_ingest_sources', 'run_ingest', 'get_ingest_run']) { expect(names).toContain(n); expect(toolActivity(`procurement__${n}`)).toBe('공개 자료 수집 중'); }
    const run = TOOL_DEFS.find(t => t.name === 'run_ingest')!;
    expect(run.required).toEqual(['source']);
    for (const s of INGEST_SOURCES) expect(run.properties.source.description).toContain(s.id);
  });

  it('미리보기는 적재하지 않고 행 수·표본만 돌려준다', async () => {
    const calls = stubNetwork({ 'https://www.law.cornell.edu/': () => new Response(readFileSync(fixture('itar-126-1.html'), 'utf8')) });
    const { ctx } = await context();
    const r = await call(ctx, 'run_ingest', { source: 'itar' });
    expect(r.status).toBe('completed');
    expect(r.dryRun).toBe(true);
    expect(calls).toEqual(['https://www.law.cornell.edu/cfr/text/22/126.1']);
    const t = r.summary.tables.export_controls;
    expect(t.rows).toBeGreaterThan(3);
    expect(t.sample.length).toBe(3);
    expect(r.summary.written).toEqual({ export_controls: 0 });
    expect(await selectRows(repo, 'export_controls', { source_id: 'itar_126_1' })).toEqual([]);
    expect(JSON.stringify(r).length).toBeLessThan(6000);
    const events = await repo.all('SELECT name, data FROM events WHERE run_id=? ORDER BY id', ctx.runId);
    expect(events.map(e => e.name)).toEqual(expect.arrayContaining(['tool.start', 'ingest.progress', 'tool.complete']));
    expect(events.filter(e => e.name === 'ingest.progress').map(e => JSON.parse(e.data).message).join(' ')).toContain('미리보기 완료');
  });

  it('dryRun=false는 SQLite에 적재하고 변경 기록·실행 기록을 남긴다(국가 한정)', async () => {
    stubNetwork({ 'https://www.law.cornell.edu/': () => new Response(readFileSync(fixture('itar-126-1.html'), 'utf8')) });
    const { ctx } = await context();
    const preview = await call(ctx, 'run_ingest', { source: 'itar' });
    const country = preview.summary.tables.export_controls.sample[0].country as string;
    const r = await call(ctx, 'run_ingest', { source: 'itar', dryRun: false, countries: country });
    expect(r.status).toBe('completed');
    const rows = await selectRows(repo, 'export_controls', { source_id: 'itar_126_1' });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(x => x.country))).toEqual(new Set([country]));
    expect(r.summary.written.export_controls).toBe(rows.length);
    const change = await repo.one("SELECT * FROM changes WHERE record_id='@ingest:itar' ORDER BY id DESC LIMIT 1");
    expect(change.run_id).toBe(ctx.runId);
    expect(JSON.parse(change.evidence)[0]).toMatchObject({ sourceId: 'itar_126_1', ingestRun: r.id });
    const list = await call(ctx, 'list_ingest_sources', {});
    const itar = list.sources.find((s: any) => s.source === 'itar');
    expect(itar.lastRun).toMatchObject({ id: r.id, status: 'completed', dryRun: false });
    expect(itar.lastWrite.written).toEqual({ export_controls: rows.length });
    expect(itar.stored.export_controls.rows).toBe(rows.length);
  });

  it('인자를 zod로 검증한다', async () => {
    const { ctx } = await context();
    expect((await call(ctx, 'run_ingest', { source: 'nope' })).error).toMatch(/인자 오류/);
    expect((await call(ctx, 'run_ingest', { source: 'gdelt', months: 99 })).error).toMatch(/months/);
    expect((await call(ctx, 'run_ingest', { source: 'itar', since: 2000 })).error).toMatch(/쓰지 않는 인자: since/);
    expect((await call(ctx, 'run_ingest', { source: 'ucdp', countries: '없는나라' })).error).toMatch(/국가를 알 수 없음/);
    expect((await call(ctx, 'get_ingest_run', { id: 'x' })).error).toMatch(/인자 오류/);
  });

  it('오래 걸리는 수집은 실행 중 상태를 돌려주고, 같은 출처 동시 실행을 막고, 중지할 수 있다', async () => {
    stubNetwork({ 'http://data.gdeltproject.org/': hang, 'https://data.gdeltproject.org/': hang });
    const { ctx } = await context();
    const r = await call(ctx, 'run_ingest', { source: 'gdelt', months: 1, wait: 0 });
    expect(r.status).toBe('running');
    expect(r.next).toContain('get_ingest_run');
    expect(r.summary).toBeUndefined();
    const again = await call(ctx, 'run_ingest', { source: 'gdelt', months: 1, wait: 0 });
    expect(again.error).toMatch(/이미 실행 중인 gdelt/);
    const other = await call(ctx, 'run_ingest', { source: 'tension', wait: 5 });
    expect(other.status).toBe('completed');
    const polled = await call(ctx, 'get_ingest_run', { id: r.id, wait: 1 });
    expect(polled.status).toBe('running');
    const stopped = await call(ctx, 'get_ingest_run', { id: r.id, cancel: true });
    expect(stopped.status).toBe('cancelled');
    const after = await call(ctx, 'run_ingest', { source: 'gdelt', months: 1, wait: 0 });
    expect(after.status).toBe('running');
    await call(ctx, 'get_ingest_run', { id: after.id, cancel: true });
  });

  it('생존 신호가 끊긴 작업은 실패로 정리하고 새 실행을 허용한다', async () => {
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    await repo.run('INSERT INTO ingest_runs(id,source,params,dry_run,status,owner,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), 'oryx', '{}', 1, 'running', 'elsewhere:1', old, old);
    stubNetwork({ 'https://www.oryxspioenkop.com/': () => new Response(readFileSync(fixture('oryx-russia.html'), 'utf8')) });
    const { ctx } = await context();
    const r = await call(ctx, 'run_ingest', { source: 'oryx', side: 'rus' });
    expect(r.status).toBe('completed');
    expect((await repo.one("SELECT COUNT(*) AS n FROM ingest_runs WHERE source='oryx' AND status='failed'")).n).toBe(1);
  });
});
