import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { Repository, now, hash } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut, systemPrompt, TOOL_DEFS } from '../server/agent';
import { saveAppContext, readAppContext, pendingCommands, acknowledgeCommand, screenSettings } from '../server/app-context';

// 브라우저가 없는 단위 시험: 화면 도구는 기다리지 않고 접수(pending) 결과를 바로 돌려준다. 대기 동작은 아래 전용 시험에서 확인한다.
screenSettings.waitMs = 0;
import { publicAddress, robotsAllowed, htmlText, sourceNetwork } from '../server/sources';
import { publishArtifact, POWERPOINT_MIME } from '../server/artifacts';
import type { AppContext } from '../shared/app-context';
import { commandVersionMatches } from '../shared/app-context';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-workflow-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
  await repo.data();
  const c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'test', 'running', now());
  const state: AppContext = { screenId: randomUUID(), version: 1, conversationId: c.id, model: 'gpt', activeView: 'map', mode: 'sph', flat: false, focus: 'POL', filters: { system: 'sph' }, report: null, dataVersion: 1 };
  await saveAppContext(repo, state);
  return { repo, state, controller, ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {}, appContext: state } };
}
async function submission() {
  const saved: any = await runTool('save_source', { url: 'https://example.org/evidence', content: '가상 검증 원문. 신규 장비 12문을 2028년에 도입한다.', kind: 'original', publishedAt: '2026-10-17' }, newOut());
  return { record: { country: '폴란드', system: '자주포', batches: [{ model: '새 장비', qty: '12문', introYear: '2028년', src: ['new-source'] }], src: ['new-source'] }, sources: { 'new-source': { ...saved, t: '가상 원문', u: 'https://example.org/evidence', y: 2026 } }, evidence: [{ path: 'batches', sourceId: 'new-source', quote: '신규 장비 12문을 2028년에 도입한다.' }], reason: '가상 도입 기록 추가', asOf: '2026-10-17' };
}
describe('화면 도구 set_map_state', () => {
  afterEach(() => { screenSettings.waitMs = 0; });
  it('일반 필드에 한국어 이름·ISO 코드·별칭을 받고, 브라우저 적용 결과를 기다려 바로 돌려준다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      screenSettings.waitMs = 2000;
      const call = runTool('set_map_state', { country: '핀란드', system: '자주포', flat: true }, newOut());
      let command: any;
      for (let i = 0; i < 50 && !command; i++) { command = (await pendingCommands(f.repo, f.state.screenId))[0]; if (!command) await new Promise(r => setTimeout(r, 20)); }
      expect(command.data).toMatchObject({ type: 'set_map_state', country: 'FIN', system: 'sph', flat: true });
      await acknowledgeCommand(f.repo, f.state.screenId, command.id, { status: 'applied', version: 2 });
      expect(await call).toMatchObject({ ok: true, status: 'applied', commandId: command.id, version: 2 });
      screenSettings.waitMs = 0;
      for (const [country, iso] of [['UK', 'GBR'], ['JPN', 'JPN'], ['해제', null]] as const) {
        const r: any = await runTool('set_map_state', { country }, newOut());
        expect((await f.repo.one('SELECT data FROM app_commands WHERE id=?', r.commandId)).data).toContain(JSON.stringify({ type: 'set_map_state', country: iso }).slice(1, -1));
      }
      expect(await runTool('set_map_state', { system: '레이저' }, newOut())).toMatchObject({ ok: false, status: 'failed', error: expect.stringContaining('무기체계 확인 필요') });
      expect(await runTool('set_map_state', {}, newOut())).toMatchObject({ ok: false, status: 'failed' });
    }); } finally { await f.repo.close(); }
  });
  it('탭이 숨겨졌으면 inactive와 안내를 돌려주고 명령은 남겨 두며, 화면이 끊겼으면 접수하지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      await saveAppContext(f.repo, { ...f.state, hidden: true });
      screenSettings.waitMs = 50;
      const hidden: any = await runTool('set_map_state', { country: '폴란드', system: '다연장로켓' }, newOut());
      expect(hidden).toMatchObject({ ok: false, status: 'inactive', message: expect.stringContaining('백그라운드') });
      expect((await pendingCommands(f.repo, f.state.screenId)).map(c => c.id)).toEqual([hidden.commandId]);
      await f.repo.run('UPDATE app_contexts SET updated_at=? WHERE screen_id=?', '2000-01-01T00:00:00Z', f.state.screenId);
      expect(await runTool('set_map_state', { country: '핀란드' }, newOut())).toMatchObject({ ok: false, status: 'inactive', message: expect.stringContaining('닫혀') });
      expect(await pendingCommands(f.repo, f.state.screenId)).toHaveLength(1);
    }); } finally { await f.repo.close(); }
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
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      await saveAppContext(f.repo, { ...f.state, version: 2, focus: 'FIN', mode: 'ifv', filters: { system: 'ifv' } });
      const context: any = await runTool('get_app_context', {}, newOut());
      expect(context.request.focus).toBe('POL'); expect(context.current.state.focus).toBe('FIN');
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
      const state: AppContext = { ...f.state, version: 2, activeView: 'report', report: { id: row.id, country: 'POL', system: 'sph', kind: 'country-analysis', basisDate: row.basis_date, dataVersion: row.data_version } };
      await saveAppContext(f.repo, state);
      await f.repo.run("UPDATE metadata SET value='2' WHERE key='revision'");
      await executions.run({ ...f.ctx, appContext: state }, async () => {
        const packet: any = await runTool('prepare_report', {}, newOut());
        expect(packet.basis).toBe('viewed'); expect(packet.revision).toBe(row.data_version); expect(packet.markdown).toBe(row.markdown); expect(packet.records).toBeUndefined();
        expect(await runTool('prepare_report', { basis: 'latest' }, newOut())).toMatchObject({ basis: 'latest', revision: 2 });
      });
      await expect(saveAppContext(f.repo, { ...state, report: { ...state.report, dataVersion: 999 } })).rejects.toThrow(/기준/);
    } finally { await f.repo.close(); }
  });
  it('화면 명령은 접수와 적용을 구분하고 탭과 상태 버전 및 대화가 다른 경우를 거절한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const result: any = await runTool('set_map_state', { payload: JSON.stringify({ country: '핀란드', flat: true }) }, newOut());
      expect(result.status).toBe('pending');
      expect(await pendingCommands(f.repo, randomUUID())).toEqual([]);
      expect(await pendingCommands(f.repo, f.state.screenId)).toHaveLength(1);
      await acknowledgeCommand(f.repo, f.state.screenId, result.commandId, { status: 'applied' });
      expect(await runTool('get_app_command', { commandId: result.commandId }, newOut())).toMatchObject({ status: 'applied' });
      await saveAppContext(f.repo, { ...f.state, version: 2, focus: 'CAN' });
      expect(await runTool('set_map_state', { payload: '{"country":"FIN"}' }, newOut())).toHaveProperty('error');
      const other = await f.repo.createConversation();
      await saveAppContext(f.repo, { ...f.state, version: 3, conversationId: other.id });
      expect(await runTool('switch_conversation', { conversationId: f.ctx.conversationId }, newOut())).toHaveProperty('error');
      expect(f.ctx.conversationId).not.toBe(other.id);
      await f.repo.run('UPDATE app_contexts SET updated_at=? WHERE screen_id=?', '2000-01-01T00:00:00Z', f.state.screenId);
      expect(await readAppContext(f.repo, f.state.screenId)).toMatchObject({ stale: true });
    }); } finally { await f.repo.close(); }
  });
  it('같은 실행의 모드 변경→국가 선택→보고서는 적용 버전을 이어받고 사용자 변경은 거절한다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const mode: any = await runTool('set_mode', { system: '다연장로켓' }, newOut());
      expect(mode.status).toBe('pending');
      const changed = { ...f.state, version: 2, mode: 'mrl' as const, filters: { system: 'mrl' as const } };
      await expect(acknowledgeCommand(f.repo, f.state.screenId, mode.commandId, { status: 'applied', version: 3, state: changed })).rejects.toThrow(/적용 버전/);
      await acknowledgeCommand(f.repo, f.state.screenId, mode.commandId, { status: 'applied', version: 2, state: changed });
      expect(await readAppContext(f.repo, f.state.screenId)).toMatchObject({ state: { mode: 'mrl', version: 2 } });
      const focused: any = await runTool('focus_country', { country: '폴란드' }, newOut());
      expect(focused.status).toBe('pending');
      expect((await f.repo.one('SELECT expected_version FROM app_commands WHERE id=?', focused.commandId)).expected_version).toBe(2);
      const out = newOut(), report: any = await runTool('write_report', { country: '폴란드', system: '다연장로켓' }, out);
      expect(report).toMatchObject({ status: 'pending', shown: false });
      expect(out.actions).toEqual([]);
      const command = (await pendingCommands(f.repo, f.state.screenId)).find(c => c.id === report.commandId)!;
      expect(command.data).toMatchObject({ type: 'show_report', country: 'POL', system: 'mrl', reportId: report.reportId });
      expect(await f.repo.one('SELECT id FROM reports WHERE id=?', report.reportId)).toBeTruthy();
      await saveAppContext(f.repo, { ...changed, version: 3, focus: 'FIN' });
      expect(await runTool('focus_country', { country: '폴란드' }, newOut())).toHaveProperty('error');
      expect(await runTool('set_map_state', { payload: '{"country":"POL"}', expectedVersion: 1 }, newOut())).toHaveProperty('error');
      expect(await runTool('set_map_state', { payload: '{"country":"POL"}', expectedVersion: 3 }, newOut())).toMatchObject({ status: 'pending' });
    }); } finally { await f.repo.close(); }
  });
  it('적용 확인은 브라우저 응답을 기다리고 확인된 변경 경로에 없는 버전은 허용하지 않는다', async () => {
    const f = await fixture();
    try { await executions.run(f.ctx, async () => {
      const command: any = await runTool('set_map_state', { payload: '{"country":"FIN"}' }, newOut());
      const pending = runTool('get_app_command', { commandId: command.commandId }, newOut());
      await acknowledgeCommand(f.repo, f.state.screenId, command.commandId, { status: 'applied', version: 2 });
      expect(await pending).toMatchObject({ status: 'applied', result: { version: 2 } });
      const edges = [{ expectedVersion: 2, version: 3 }, { expectedVersion: 1, version: 2 }];
      expect(commandVersionMatches(1, 3, edges)).toBe(true);
      expect(commandVersionMatches(1, 4, edges)).toBe(false);
      expect(commandVersionMatches(1, 3, [{ expectedVersion: 2, version: 3 }])).toBe(false);
    }); } finally { await f.repo.close(); }
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
