import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { Repository, now, hash } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut, systemPrompt, TOOL_DEFS } from '../server/agent';
import { validateAppContext } from '../server/app-context';
import { hostScreens, connectScreen, completeCommand, updateScreen, screenSettings } from '../server/screen-hub';
import { publicAddress, robotsAllowed, htmlText, sourceNetwork } from '../server/sources';
import { publishArtifact, POWERPOINT_MIME } from '../server/artifacts';
import type { AppContext } from '../shared/app-context';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-workflow-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
  await repo.data();
  const c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
  const state: AppContext = { screenId: randomUUID(), conversationId: c.id, model: 'gpt', activeView: 'map', mode: 'sph', flat: false, focus: 'POL', filters: { system: 'sph' }, report: null, dataVersion: 1 };
  await validateAppContext(repo, state);
  return { repo, state, controller, ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {}, appContext: state } };
}
/** 앱 서버 프로세스의 화면 허브에 붙은 가짜 브라우저 탭. reply가 결과를 주면 바로 적용 결과를 돌려준다 */
const screens: (() => void)[] = [];
function fakeScreen(reply: ((data: any) => { status: 'applied' | 'failed'; detail?: string; state?: AppContext } | null) = () => ({ status: 'applied' })) {
  hostScreens();
  const id = randomUUID(), commands: any[] = [];
  const disconnect = connectScreen(id, (event, payload: any) => {
    if (event !== 'command') return;
    commands.push(payload.data);
    const result = reply(payload.data);
    if (result) queueMicrotask(() => completeCommand(id, payload.id, result));
  });
  screens.push(disconnect);
  return { id, commands, disconnect };
}
afterEach(() => { for (const disconnect of screens.splice(0)) disconnect(); screenSettings.timeoutMs = 6000; });
async function submission() {
  const saved: any = await runTool('save_source', { url: 'https://example.org/evidence', content: '가상 검증 원문. 신규 장비 12문을 2028년에 도입한다.', kind: 'original', publishedAt: '2026-10-17' }, newOut());
  return { record: { country: '폴란드', system: '자주포', batches: [{ model: '새 장비', qty: '12문', introYear: '2028년', src: ['new-source'] }], src: ['new-source'] }, sources: { 'new-source': { ...saved, t: '가상 원문', u: 'https://example.org/evidence', y: 2026 } }, evidence: [{ path: 'batches', sourceId: 'new-source', quote: '신규 장비 12문을 2028년에 도입한다.' }], reason: '가상 도입 기록 추가', asOf: '2026-10-17' };
}
describe('화면 도구 set_map_state', () => {
  it('일반 필드에 한국어 이름·ISO 코드·별칭을 받고, 브라우저 적용 결과를 기다려 바로 돌려준다', async () => {
    const f = await fixture(), screen = fakeScreen(), before = (await f.repo.one('SELECT count(*) AS n FROM app_commands')).n;
    try { await executions.run(f.ctx, async () => {
      expect(await runTool('set_map_state', { country: '핀란드', system: '자주포', flat: true }, newOut())).toMatchObject({ ok: true, status: 'applied', screenId: screen.id });
      expect(screen.commands[0]).toMatchObject({ type: 'set_map_state', country: 'FIN', system: 'sph', flat: true });
      for (const [country, iso] of [['UK', 'GBR'], ['JPN', 'JPN'], ['해제', null]] as const) {
        await runTool('set_map_state', { country }, newOut());
        expect(screen.commands.at(-1)).toEqual({ type: 'set_map_state', country: iso });
      }
      expect(await runTool('set_map_state', { system: '레이저' }, newOut())).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('무기체계 확인 필요') });
      expect(await runTool('set_map_state', {}, newOut())).toMatchObject({ ok: false, status: 'failed' });
      // 화면 명령은 DB를 쓰지 않는다(app_commands는 더 이상 쓰지 않는 예전 표)
      expect((await f.repo.one('SELECT count(*) AS n FROM app_commands')).n).toBe(before);
    }); } finally { await f.repo.close(); }
  });
  it('숨겨진 탭도 적용하고 hidden을 알리며, 적용 실패·시간 초과를 구분하고 시간 초과는 다시 적용하지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const hidden = fakeScreen();
      updateScreen(hidden.id, { hidden: true });
      expect(await runTool('set_map_state', { country: '폴란드', system: '다연장로켓' }, newOut())).toMatchObject({ ok: true, status: 'applied', hidden: true, message: expect.stringContaining('백그라운드') });
      hidden.disconnect();
      fakeScreen(() => ({ status: 'failed', detail: '지도 준비 안 됨' }));
      expect(await runTool('set_map_state', { country: '핀란드' }, newOut())).toMatchObject({ ok: false, status: 'failed', detail: '지도 준비 안 됨' });
      for (const disconnect of screens.splice(0)) disconnect();
      fakeScreen(() => null);
      screenSettings.timeoutMs = 50;
      const out = newOut();
      expect(await runTool('focus_country', { country: '폴란드' }, out)).toMatchObject({ ok: false, status: 'timeout' });
      expect(out.actions).toEqual([]);
    }); } finally { await f.repo.close(); }
  });
  it('연결된 화면이 없으면 바로 inactive이고, 앱에서 보낸 실행만 답과 함께 적용할 동작으로 남긴다', async () => {
    const f = await fixture();
    try {
      hostScreens();
      const started = Date.now(), out = newOut();
      // 앱 화면에서 보낸 실행(요청 화면 맥락 있음): 답이 끝나면 브라우저가 적용한다
      expect(await executions.run(f.ctx, () => runTool('set_map_state', { country: '폴란드' }, out))).toMatchObject({ ok: true, status: 'queued' });
      expect(out.actions).toEqual([{ type: 'focus_country', country: 'POL' }]);
      // 외부 MCP(요청 화면 맥락 없음): 남길 화면이 없으므로 inactive
      const external = newOut();
      expect(await executions.run({ ...f.ctx, appContext: undefined }, () => runTool('set_map_state', { country: '폴란드' }, external))).toMatchObject({ ok: false, status: 'inactive', message: expect.stringContaining('화면이 열려 있지 않음') });
      expect(external.actions).toEqual([]);
      expect(Date.now() - started).toBeLessThan(1000);
    } finally { await f.repo.close(); }
  });
  it('앱 화면 없이 부르면(화면 맥락 없음) 답과 함께 적용할 동작으로 남기고 예전 이름도 받는다', async () => {
    const out = newOut();
    expect(await runTool('set_map_state', { country: '폴란드', system: '자주포', flat: false }, out)).toMatchObject({ ok: true, status: 'queued' });
    expect(out.actions).toEqual([{ type: 'set_mode', system: 'sph' }, { type: 'toggle_map_mode', flat: false }, { type: 'focus_country', country: 'POL' }]);
    const legacy = newOut();
    await runTool('set_mode', { system: '일반' }, legacy); await runTool('toggle_map_mode', {}, legacy); await runTool('focus_country', { country: '핀란드' }, legacy);
    expect(legacy.actions).toEqual([{ type: 'set_mode', system: null }, { type: 'toggle_map_mode' }, { type: 'focus_country', country: 'FIN' }]);
  });
});

describe('새 조달 도구의 공통 실행 흐름', () => {
  it('기존 배치와 신규 자료를 합치고 원래 값과 규칙을 보존하며 사전 검증은 데이터를 바꾸지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const previous = (await f.repo.data()).records.find(r => r.country === 'POL' && r.system === 'sph')!;
      const normalized: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(await submission()) }, newOut());
      expect(normalized.ok).toBe(true);
      expect(normalized.payload.record.id).toBe(previous.id);
      expect(normalized.payload.record.batches).toHaveLength(previous.batches.length + 1);
      expect(normalized.payload.record.batches.at(-1)).toMatchObject({ qty: 12, introYear: 2028 });
      expect(readFileSync(f.repo.path(f.ctx.conversationId, normalized.auditPath), 'utf8')).toContain('12문');
      expect(await runTool('validate_research', { payload: JSON.stringify(normalized.payload) }, newOut())).toMatchObject({ valid: true });
      expect(await f.repo.revision()).toBe(1);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(0);
      expect(await runTool('apply_research', { payload: JSON.stringify(normalized.payload) }, newOut())).toMatchObject({ ok: true, version: 2 });
      expect(await runTool('apply_research', { payload: JSON.stringify(normalized.payload) }, newOut())).toMatchObject({ unchanged: true, version: 2 });
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(1);
      expect((await f.repo.one('SELECT template_version FROM research')).template_version).toContain('normalization-v1');
      const conflict = structuredClone(normalized.payload); conflict.record.batches.at(-1).qty = 13;
      expect(await runTool('apply_research', { payload: JSON.stringify(conflict) }, newOut())).toHaveProperty('error');
    }); } finally { await f.repo.close(); }
  });
  it('기존 배치와 같은 식별 기준의 상충 값을 자동으로 채택하지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const p: any = await submission(), previous = (await f.repo.data()).records.find(r => r.country === 'POL' && r.system === 'sph')!;
      p.record.batches = [{ ...previous.batches[0], qty: previous.batches[0].qty! + 1 }];
      const result: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(p) }, newOut());
      expect(result.ok).toBe(false); expect(result.payload).toBeNull(); expect(result.conflicts.length).toBeGreaterThan(0);
      p.record = { country: 'POL', system: 'sph', plan: { start: '2031년', end: '2033년', qty: ['10문', '12문'], text: '검토 계획', src: ['new-source'] } };
      const range: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(p) }, newOut());
      expect(range.ok).toBe(true); expect(range.payload.record.plan.qty).toEqual([10, 12]);
      p.record = { country: 'POL', system: 'sph' }; p.removeFields = ['awarded'];
      const removed: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(p) }, newOut());
      expect(removed.ok).toBe(true); expect(removed.payload.record.awarded).toBeUndefined(); expect(removed.payload.record.batches).toEqual(previous.batches);
      p.record.batches = [{ ...previous.batches[0], qty: '미확인' }]; p.replaceFields = ['batches'];
      const unknown: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(p) }, newOut());
      expect(unknown.ok).toBe(true); expect(unknown.candidate.record.batches[0].qty).toBeNull();
      expect(await f.repo.revision()).toBe(1);
    }); } finally { await f.repo.close(); }
  });
  it('사전 검증 이후 원문 변경과 중지가 발생하면 최종 반영을 거부한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const normalized: any = await runTool('normalize_procurement_data', { payload: JSON.stringify(await submission()) }, newOut());
      const a = { payload: JSON.stringify(normalized.payload) };
      expect(await runTool('validate_research', a, newOut())).toMatchObject({ valid: true });
      const path = f.repo.path(f.ctx.conversationId, normalized.payload.sources['new-source'].filePath);
      writeFileSync(path, '변조된 원문');
      expect(await runTool('apply_research', a, newOut())).toHaveProperty('error');
      expect(await f.repo.revision()).toBe(1);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(0);
      await f.repo.run("UPDATE runs SET status='stopping' WHERE id=?", f.ctx.runId);
      await expect(runTool('apply_research', a, newOut())).rejects.toThrow(/중지/);
    }); } finally { await f.repo.close(); }
  });
  it('요청 당시 화면과 최신 화면을 구분하고 명시한 국가를 우선하며 작성 자료는 버전을 고정한다', async () => {
    const f = await fixture(), screen = fakeScreen();
    try { await executions.run(f.ctx, async () => {
      updateScreen(screen.id, { state: { ...f.state, focus: 'FIN', mode: 'ifv', filters: { system: 'ifv' } } });
      const context: any = await runTool('get_app_context', {}, newOut());
      expect(context.request.focus).toBe('POL'); expect(context.current).toMatchObject({ available: true, screenId: screen.id, state: { focus: 'FIN' } });
      expect(systemPrompt({})).toContain('"focus":"POL"');
      const implicit: any = await runTool('prepare_report', {}, newOut());
      const explicit: any = await runTool('prepare_report', { country: 'FIN', system: 'sph' }, newOut());
      expect(implicit.country).toBe('POL'); expect(implicit.system).toBe('sph');
      expect(explicit.country).toBe('FIN'); expect(explicit.system).toBe('sph');
      const stored = readFileSync(f.repo.path(f.ctx.conversationId, implicit.filePath));
      await f.repo.run("UPDATE metadata SET value='2' WHERE key='revision'");
      expect(JSON.parse(stored.toString()).revision).toBe(1);
      expect(hash(readFileSync(f.repo.path(f.ctx.conversationId, implicit.filePath)))).toBe(implicit.hash);
    }); } finally { await f.repo.close(); }
  });
  it('열린 보고서의 내용과 기준을 보존하고 최신 데이터와 혼합하지 않는다', async () => {
    const f = await fixture();
    try {
      await executions.run(f.ctx, () => runTool('write_report', { country: 'POL', system: 'sph' }, newOut()));
      const row = await f.repo.one('SELECT * FROM reports WHERE run_id=?', f.ctx.runId);
      const state: AppContext = await validateAppContext(f.repo, { ...f.state, activeView: 'report', report: { id: row.id, country: 'POL', system: 'sph', kind: 'country-analysis', basisDate: row.basis_date, dataVersion: row.data_version } });
      await f.repo.run("UPDATE metadata SET value='2' WHERE key='revision'");
      await executions.run({ ...f.ctx, appContext: state }, async () => {
        const packet: any = await runTool('prepare_report', {}, newOut());
        expect(packet.basis).toBe('viewed'); expect(packet.revision).toBe(row.data_version); expect(packet.markdown).toBe(row.markdown); expect(packet.records).toBeUndefined();
        expect(await runTool('prepare_report', { basis: 'latest' }, newOut())).toMatchObject({ basis: 'latest', revision: 2 });
      });
      await expect(validateAppContext(f.repo, { ...state, report: { ...state.report, dataVersion: 999 } })).rejects.toThrow(/기준/);
    } finally { await f.repo.close(); }
  });
  it('대화 전환·모델 변경·보고서 표시는 가장 최근에 사용한 탭으로 가고, 사용자가 화면을 바꿨어도 적용한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const older = fakeScreen(), newer = fakeScreen();
      updateScreen(newer.id, { state: { ...f.state, focus: 'CAN' } }); // 사용자가 화면을 바꿈(버전·충돌 개념 없음)
      const other = await f.repo.createConversation();
      expect(await runTool('switch_conversation', { conversationId: other.id }, newOut())).toMatchObject({ status: 'applied', screenId: newer.id });
      expect(newer.commands.at(-1)).toEqual({ type: 'switch_conversation', conversationId: other.id });
      expect(await runTool('switch_conversation', { conversationId: randomUUID() }, newOut())).toHaveProperty('error');
      updateScreen(older.id, { active: true });
      expect(await runTool('set_mode', { system: '다연장로켓' }, newOut())).toMatchObject({ status: 'applied', screenId: older.id });
      updateScreen(older.id, { hidden: true }); // 보이는 탭이 우선
      const out = newOut(), report: any = await runTool('write_report', { country: '폴란드', system: '다연장로켓' }, out);
      expect(report).toMatchObject({ status: 'applied', shown: true, screenId: newer.id });
      expect(out.actions).toEqual([]);
      expect(newer.commands.at(-1)).toMatchObject({ type: 'show_report', conversationId: f.ctx.conversationId, country: 'POL', system: 'mrl', reportId: report.reportId });
      expect(await f.repo.one('SELECT id FROM reports WHERE id=?', report.reportId)).toBeTruthy();
      expect(older.commands.map(c => c.type)).toEqual(['set_map_state']);
    }); } finally { await f.repo.close(); }
  });
  it('보고서 작성은 화면이 없으면 저장만 하고, 앱에서 보낸 실행이면 답과 함께 국가를 보여 준다', async () => {
    const f = await fixture();
    try {
      hostScreens();
      const out = newOut();
      const report: any = await executions.run(f.ctx, () => runTool('write_report', { country: '폴란드', system: '자주포' }, out));
      expect(report).toMatchObject({ shown: false, saved: true });
      expect(out.actions).toEqual([{ type: 'focus_country', country: 'POL' }]);
      const external = newOut();
      expect(await executions.run({ ...f.ctx, appContext: undefined }, () => runTool('write_report', { country: '폴란드', system: '자주포' }, external))).toMatchObject({ status: 'inactive', shown: false, saved: true });
      expect(external.actions).toEqual([]);
    } finally { await f.repo.close(); }
  });
  it('자기 실행 중지는 종료를 기다리지 않고 반환하며 대화 삭제는 근거를 보존한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const other = await f.repo.createConversation();
      const artifact = await f.repo.artifact(other.id, 'sources/preserved.txt', '보존 원문', { kind: 'original' });
      expect(await runTool('delete_conversation', { conversationId: other.id }, newOut())).toMatchObject({ evidencePreserved: true });
      expect(readFileSync(artifact.path, 'utf8')).toBe('보존 원문');
      expect((await f.repo.one('SELECT conversation_id FROM artifacts WHERE id=?', artifact.id)).conversation_id).toBeNull();
      expect(await runTool('cancel_run', {}, newOut())).toMatchObject({ status: 'stopping' });
      expect((await f.repo.runStatus(f.ctx.runId)).status).toBe('stopping');
    }); } finally { await f.repo.close(); }
  });
  it('파워포인트 완성 파일과 검수 및 작성 버전을 연결하고 원본 수정 후에도 사본을 유지한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const packet: any = await runTool('prepare_report', { templateId: 'ppt-country-v1' }, newOut());
      const bytes = zipSync({
        '[Content_Types].xml': strToU8(`<Types><Override PartName="/ppt/presentation.xml" ContentType="${POWERPOINT_MIME}.main+xml"/></Types>`),
        'ppt/presentation.xml': strToU8('<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>'),
        'ppt/_rels/presentation.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>'),
        'ppt/slides/slide1.xml': strToU8('<p:sld><p:cSld><p:spTree/></p:cSld></p:sld>'),
      });
      const path = f.repo.path(f.ctx.conversationId, 'reports/summary.pptx'); writeFileSync(path, bytes);
      await expect(publishArtifact(path, f.ctx, { preparationId: packet.id })).rejects.toThrow(/검수/);
      const file = await publishArtifact(path, f.ctx, { preparationId: packet.id, review: '{"content":true,"layout":true,"notes":"가상 검수 기록"}' });
      const saved = await f.repo.one('SELECT * FROM artifacts WHERE id=?', file.id);
      expect(saved.mime).toBe(POWERPOINT_MIME); expect(readFileSync(saved.path)).toEqual(Buffer.from(bytes));
      writeFileSync(path, '수정한 원본'); expect(readFileSync(saved.path)).toEqual(Buffer.from(bytes));
      const registration = await f.repo.one("SELECT path FROM artifacts WHERE kind='report-registration'");
      expect(JSON.parse(readFileSync(registration.path, 'utf8'))).toMatchObject({ preparationId: packet.id, dataVersion: 1, templateVersion: 'report-templates-v1' });
    }); } finally { await f.repo.close(); }
  });
  it('공개 원본과 추출문을 각각 보존하고 수집 실패와 검색 요약을 구분한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const bytes = Buffer.from('<html><script>ignore()</script><h1>공개 계약</h1><p>수량 12 &amp; 근거</p></html>');
      const fetch = vi.spyOn(sourceNetwork, 'fetch').mockResolvedValue({ status: 200, headers: {}, bytes, url: 'https://example.org/public', mime: 'text/html' });
      const result: any = await runTool('collect_source', { url: 'https://example.org/public' }, newOut());
      expect(readFileSync(f.repo.path(f.ctx.conversationId, result.originalPath))).toEqual(bytes);
      expect(result.y).toBe(0); expect(result.publishedAt).toBeNull();
      const read: any = await runTool('read_source', { filePath: result.filePath }, newOut());
      expect(read.text).toContain('수량 12 & 근거'); expect(read.text).not.toContain('ignore');
      fetch.mockResolvedValueOnce({ status: 200, headers: {}, bytes: Buffer.from('{"results":[{"title":"후보","link":"/candidate","description":"검색 요약"}]}'), url: 'https://www.gov.uk/api/search.json', mime: 'application/json' });
      const search: any = await runTool('search_sources', { query: 'procurement' }, newOut());
      expect(search.verified).toBe(false); expect(search.candidates.some((c: any) => c.kind === 'search')).toBe(true);
      fetch.mockRejectedValue(new Error('접근 실패'));
      expect(await runTool('collect_source', { url: 'https://example.org/failure' }, newOut())).toHaveProperty('error');
      expect(await f.repo.all("SELECT id FROM artifacts WHERE kind='failure' AND status='failed'")).toHaveLength(1);
    }); } finally { await f.repo.close(); }
  });
  it('문서 뷰어의 메뉴를 원문으로 인정하지 않고 첨부 문서 주소를 돌려준다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      vi.spyOn(sourceNetwork, 'fetch').mockResolvedValue({ status: 200, headers: {}, url: 'https://example.org/press', mime: 'text/html', bytes: Buffer.from('<nav>메뉴 검색</nav><iframe id="content_press" src="/docViewer/iframe_skin/doc.html"></iframe><a href="/download?id=1&amp;type=pdf">보도자료.pdf</a><a href="https://evil.example/file">다른 문서.pdf</a>') });
      const result: any = await runTool('collect_source', { url: 'https://example.org/press' }, newOut());
      expect(result).toMatchObject({ status: 'needs_attachment', attachments: [{ url: 'https://example.org/download?id=1&type=pdf' }] });
      expect(result.filePath).toBeUndefined();
      expect(await f.repo.all("SELECT * FROM artifacts WHERE kind='original'")).toHaveLength(0);
    }); } finally { await f.repo.close(); }
  });
});
describe('공개 자료 수집 경계', () => {
  it('내부 주소를 차단하고 공개 주소를 허용한다', () => {
    for (const address of ['127.0.0.1', '10.1.1.1', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) expect(publicAddress(address)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2606:4700::1111')).toBe(true);
  });
  it('robots 규칙의 경로와 허용 우선순위를 지키며 스크립트를 본문으로 쓰지 않는다', () => {
    const robots = 'User-agent: *\nDisallow: /private/*\nAllow: /private/public$';
    expect(robotsAllowed(robots, '/private/secret')).toBe(false); expect(robotsAllowed(robots, '/private/public')).toBe(true); expect(robotsAllowed(robots, '/public')).toBe(true);
    expect(htmlText('<style>bad</style><p>사실 &#49;&#50;</p>')).toBe('사실 12');
  });
  it('도구 이름이 중복되지 않고 신규 도구가 모델 공통 목록에 노출된다', () => {
    expect(new Set(TOOL_DEFS.map(t => t.name)).size).toBe(TOOL_DEFS.length);
    for (const name of ['search_sources', 'collect_source', 'read_source', 'normalize_procurement_data', 'validate_research', 'apply_research', 'get_app_context', 'set_map_state', 'switch_conversation', 'prepare_report', 'publish_artifact']) expect(TOOL_DEFS.some(t => t.name === name)).toBe(true);
  });
});
