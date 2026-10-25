import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from './env';
import { listModels, defaultModel } from './models';
import { GPT_MODEL } from './openai';
import { cliChoice } from './cli';
import { TOOL_IMPLS, listForecasts, writeReport } from '../shared/tools';
import { seed } from '../shared/data';
import { repository, hash } from './store';
import { startRun, stopRun, stopConversation } from './runs';
import { attach } from './attachments';
import { bodyLimit } from 'hono/body-limit';
import { appContextSchema } from './app-context';
import { hostScreens, connectScreen, updateScreen, completeCommand, dispatchScreenCommand, screenSnapshot, screenSettings, SCREEN_COMMANDS, type ScreenCommandData } from './screen-hub';
import { localOnly, remoteOf } from './local-only';
import { streamSSE } from 'hono/streaming';
import { reportEntry, saveViewedReport } from './viewed-reports';
import { TOOL_DEFS } from './agent';
import { executeTool } from './tool-session';
import { scoreCase, scoreSystem, scoreSummary } from './scoring';
import { allWeapons, lookupWeapon } from './weapons';
import { resolveCountry, resolveSystem } from '../shared/data';
import { renderReportPdf } from './report-pdf';
import { deleteSetting, listSettings, reloadSettingsConfig, writeSetting, SETTINGS_NAMES } from './settings-secrets';
import { completeLink, createLink, remoteStatus, retryRelay, savedLinkState, unlinkRelay } from './remote-relay';

/** Origin 헤더가 없으면(도구, CLI) 허용, 있으면 요청 Host와 같아야 한다 */
export function sameOrigin(origin: string | undefined, host: string | undefined) {
  if (!origin) return true;
  try { return !!host && new URL(origin).host === host; } catch { return false; }
}
export const app = new Hono<{ Bindings: Env }>().basePath('/api');
// 이 컴퓨터의 localhost 요청만 받는다(루프백 주소, localhost Host, 같은 출처). 접속 주소는 원래 요청 객체에 붙어 있어 본문 제한 미들웨어(요청 객체를 바꿀 수 있음)보다 먼저 확인한다
app.use('/screen/*', async (c, next) => {
  const denied = localOnly({ remote: remoteOf(c.req.raw), host: c.req.header('host') || new URL(c.req.url).host, origin: c.req.header('origin') });
  if (denied) return c.json({ error: denied }, 403);
  await next();
  c.header('cache-control', 'no-store');
});
app.use('/settings/secrets', async (c, next) => {
  const denied = localOnly({ remote: remoteOf(c.req.raw), host: c.req.header('host') || new URL(c.req.url).host, origin: c.req.header('origin') });
  if (denied) return c.json({ error: denied }, 403);
  await next();
  c.header('cache-control', 'no-store');
});
app.use('/remote/*', async (c, next) => {
  const denied = localOnly({ remote: remoteOf(c.req.raw), host: c.req.header('host') || new URL(c.req.url).host, origin: c.req.header('origin') });
  if (denied) return c.json({ error: denied }, 403);
  await next(); c.header('cache-control', 'no-store');
});
app.use('*', bodyLimit({ maxSize: 40 * 1024 * 1024, onError: c => c.json({ error: '첨부는 요청당 40MB까지 가능합니다' }, 413) }));
// 다른 사이트에서 보낸 쓰기 요청(CSRF)을 막는다. Origin이 없는 도구, CLI 호출과 같은 출처의 앱 요청만 받는다
app.use('*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !sameOrigin(c.req.header('origin'), c.req.header('host') || new URL(c.req.url).host)) return c.json({ error: '다른 출처의 요청은 받지 않습니다' }, 403);
  await next();
});

/* ───────── 화면 허브(로컬 전용, DB 미사용): 열린 지도 탭 ↔ MCP, 모델 도구의 실시간 화면 명령 ───────── */
hostScreens();
const screenId = z.string().uuid();
/** 브라우저 탭 연결(SSE). 명령은 event: command { id, data }로 바로 보낸다 */
app.get('/screen/events', c => {
  const id = screenId.safeParse(c.req.query('screen'));
  if (!id.success) return c.json({ error: '화면 ID가 필요합니다' }, 400);
  return streamSSE(c, async stream => {
    const closed = new Promise<void>(resolve => stream.onAbort(resolve));
    const disconnect = connectScreen(id.data, (event, data) => { void stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {}); });
    const ping = setInterval(() => { void stream.write(': ping\n\n').catch(() => {}); }, 15_000);
    try { await stream.writeSSE({ event: 'ready', data: JSON.stringify({ screenId: id.data }) }); await closed; }
    finally { clearInterval(ping); disconnect(); }
  });
});
const screenStateSchema = z.object({ screenId, state: appContextSchema.optional(), hidden: z.boolean().optional(), active: z.boolean().optional() }).strict();
/** 화면 상태, 탭 숨김, 사용 활동(가장 최근에 사용한 탭이 명령 대상) */
app.post('/screen/state', async c => {
  const p = screenStateSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success || (p.data.state && p.data.state.screenId !== p.data.screenId)) return c.json({ error: '화면 상태 형식이 올바르지 않습니다' }, 400);
  return c.json({ ok: true, connected: updateScreen(p.data.screenId, p.data) });
});
const screenResultSchema = z.object({ screenId, status: z.enum(['applied', 'failed']), detail: z.string().max(2000).optional(), state: appContextSchema.optional() }).strict();
/** 브라우저가 명령 적용 결과를 돌려준다. 이미 시간 초과된 명령이면 accepted=false */
app.post('/screen/results/:id', async c => {
  const p = screenResultSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ error: '적용 결과 형식이 올바르지 않습니다' }, 400);
  return c.json({ ok: true, accepted: completeCommand(p.data.screenId, c.req.param('id'), p.data) });
});
const screenCommandSchema = z.object({ data: z.object({ type: z.enum(SCREEN_COMMANDS) }).passthrough(), timeoutMs: z.number().int().optional() }).strict();
/** MCP 서버 등 다른 로컬 프로세스의 화면 명령. 적용 결과(applied, failed, inactive, timeout)를 동기로 돌려준다 */
app.post('/screen/command', async c => {
  const p = screenCommandSchema.safeParse(await c.req.json().catch(() => null));
  if (!p.success) return c.json({ ok: false, status: 'failed', error: '화면 명령 형식이 올바르지 않습니다' }, 400);
  const timeout = Math.min(30_000, Math.max(500, p.data.timeoutMs ?? screenSettings.timeoutMs));
  return c.json(await dispatchScreenCommand(p.data.data as ScreenCommandData, timeout, c.req.raw.signal));
});
/** 지금 화면 상태(가장 최근에 사용한 탭) */
app.get('/screen/context', c => c.json(screenSnapshot()));

app.get('/settings/secrets', async c => c.json(await listSettings(), 200, { 'cache-control': 'no-store' }));
app.put('/settings/secrets', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !SETTINGS_NAMES.includes(body.name) || typeof body.value !== 'string') return c.json({ error: '설정 이름과 값을 확인해 주세요.' }, 400);
  try { await writeSetting(body.name, body.value); reloadSettingsConfig(); return c.json({ ok: true }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : '설정을 저장하지 못했습니다.' }, 400); }
});
app.get('/remote/status', c => c.json(remoteStatus()));
app.post('/remote/link', async c => {
  const body = await c.req.json().catch(() => null);
  const device = typeof body?.device === 'string' ? body.device.trim() : '';
  if (!device) return c.json({ error: '기기 이름을 입력해 주세요.' }, 400);
  const saved = await savedLinkState();
  if (saved.hasKey && saved.device === device && remoteStatus().state !== 'login_required') { await retryRelay(); return c.json({ state: remoteStatus().state }); }
  return c.json({ url: createLink(device, Number(process.env.PORT || 62356)) });
});
app.post('/remote/unlink', c => { unlinkRelay(); return c.json({ ok: true }); });
app.get('/remote/callback', async c => {
  try {
    if (c.req.query('error')) throw new Error(c.req.query('error'));
    const result = await completeLink(c.req.query('code') || '', c.req.query('state') || '');
    reloadSettingsConfig();
    return c.html(`<meta charset="utf-8"><title>HORUS</title><p>연결이 완료되었습니다. 이 창을 닫고 HORUS로 돌아가세요.</p>`);
  } catch (error) { return c.html(`<meta charset="utf-8"><title>HORUS</title><p>${String(error instanceof Error ? error.message : '연결에 실패했습니다.').replace(/[&<>"']/g, ch => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[ch]!) )}</p>`, 400); }
});
app.delete('/settings/secrets', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.name !== 'string' || !SETTINGS_NAMES.includes(body.name)) return c.json({ error: '설정 이름을 확인해 주세요.' }, 400);
  try { await deleteSetting(body.name); reloadSettingsConfig(); return c.json({ ok: true }); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : '설정을 지우지 못했습니다.' }, 400); }
});

app.use('*', async (_c, next) => { await repository().data(); await next(); });
app.onError((e, c) => c.json({ error: e.message }, /찾을 수|파일 없음/.test(e.message) ? 404 : /진행 중|충돌/.test(e.message) ? 409 : 400));

app.get('/health', c => c.json({ ok: true, storage: repository().kind, ai: !!c.env?.OPENAI_API_KEY, openrouter: !!c.env?.OPENROUTER_API_KEY, model: c.env?.OPENAI_MODEL || GPT_MODEL, records: seed.records.length }));
app.get('/models', async c => {
  const env = c.env ?? {}, models = await listModels(env);
  // defaults: 세부 선택이 없을 때 서버가 실제로 쓰는 CLI 모델, 추론 강도(환경 변수 반영). 상태 줄 표시용
  return c.json({ default: defaultModel(env, models), models, defaults: { grok: cliChoice('grok', env), codex: cliChoice('codex', env) } });
});
app.get('/weapons', async c => c.json((await allWeapons()).map(w => ({ id: w.id, name: w.name, nameKo: w.nameKo, aliases: w.aliases, matchTerms: [w.name, w.nameKo, ...w.aliases], system: w.system, systemKo: w.systemKo, typeKo: w.typeKo, maker: w.maker, origin: w.origin, originKo: w.originKo, operators: w.operators, operatorsKo: w.operatorsKo, introYear: w.introYear, description: w.description }))));
app.get('/weapons/lookup', async c => { const q = c.req.query('q') || ''; const result = await lookupWeapon(q); return result.match ? c.json(result) : c.json({ error: '무기 사전에서 찾지 못했다', ...result }, 404); });
app.get('/forecasts', c => c.json(listForecasts({ system: c.req.query('system') ?? undefined, limit: 100 })));
app.get('/scores', async c => {
  const system = resolveSystem(c.req.query('system'));
  if (!system) return c.json({ error: '체계를 지정하세요' }, 400);
  const repo = repository(), snapshot = await repo.versionedData();
  return c.json({ revision: snapshot.revision, system, scores: (await scoreSystem(repo, snapshot.data, system)).map(scoreSummary) }, 200, { 'cache-control': 'no-store' });
});
// 한 국가, 체계의 항목별 점수(get_score_breakdown과 같은 scoreCase 계산). 지도 정보 카드의 종합 점수 내역용
app.get('/scores/:country', async c => {
  const system = resolveSystem(c.req.query('system'));
  if (!system) return c.json({ error: '체계를 지정하세요' }, 400);
  const country = resolveCountry(c.req.param('country'));
  if (!country) return c.json({ error: '국가를 찾을 수 없습니다' }, 404);
  const repo = repository(), snapshot = await repo.versionedData();
  return c.json({ revision: snapshot.revision, ...(await scoreCase(repo, snapshot.data, country, system)) }, 200, { 'cache-control': 'no-store' });
});
app.get('/report', c => { const r = writeReport({ country: c.req.query('country'), system: c.req.query('system') }); return 'error' in r ? c.json(r, 404) : c.text(r.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' }); });
app.post('/report-export/pdf', async c => {
  const parsed = z.object({ html: z.string().min(1).max(5 * 1024 * 1024) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'PDF 문서 형식이 올바르지 않거나 크기가 5MB를 넘습니다.' }, 400);
  if (/<\s*(?:script|iframe|object|embed)\b|\bon[a-z]+\s*=|\b(?:src|href)\s*=\s*(?:(['"])(?!data:|blob:|#|\/|\.\/|\.\.\/)[^'"]*\1|(?!data:|blob:|#|\/|\.\/|\.\.\/)[^\s>]+)|url\(\s*(?!["']?data:)[^)]*\)/i.test(parsed.data.html)) return c.json({ error: 'PDF 문서에 허용되지 않는 콘텐츠가 있습니다.' }, 400);
  const timeout = AbortSignal.timeout(30_000);
  try {
    const bytes = await Promise.race([renderReportPdf(parsed.data.html), new Promise<never>((_, reject) => timeout.addEventListener('abort', () => reject(new Error('PDF 변환 시간이 초과되었습니다.')), { once: true }))]);
    return c.body(new Uint8Array(bytes), 200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="report.pdf"' });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'PDF 변환에 실패했습니다.' }, 400); }
});
app.get('/data', async c => {
  const snapshot = await repository().versionedData();
  return c.json(snapshot.data, 200, { 'cache-control': 'no-store', 'x-data-version': String(snapshot.revision) });
});
app.get('/data/version', async c => c.json({ revision: await repository().revision() }, 200, { 'cache-control': 'no-store' }));
app.get('/conversations', async c => c.json(await repository().all('SELECT * FROM conversations ORDER BY updated_at DESC')));
app.post('/conversations', async c => c.json(await repository().createConversation(), 201));
app.get('/conversations/:id', async c => {
  const repo = repository(), id = c.req.param('id');
  const [conversation, reports] = await Promise.all([repo.conversation(id), repo.all('SELECT * FROM reports WHERE conversation_id=? ORDER BY created_at,id', id)]);
  return c.json({ ...conversation, reportEntries: reports.map(reportEntry) });
});
/** 지도에서 연 보고서: 채팅 요청 없이 저장해 표시하고, 다음 메시지에 첨부한다 */
app.post('/conversations/:id/reports', async c => {
  const body = await c.req.json().catch(() => ({}));
  try { return c.json(await saveViewedReport(repository(), c.req.param('id'), body ?? {}), 201); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
});
const renameSchema = z.object({ title: z.string().trim().min(1, '제목을 입력하세요').max(120, '제목은 120자까지') }).strict();
app.patch('/conversations/:id', async c => {
  const parsed = renameSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message || '잘못된 요청' }, 400);
  return c.json(await repository().renameConversation(c.req.param('id'), parsed.data.title));
});
app.delete('/conversations/:id', async c => {
  const id = c.req.param('id'), repo = repository();
  if (!await repo.conversationExists(id)) throw new Error('대화를 찾을 수 없습니다');
  // 진행 중 실행은 중지 요청만 하고 정리를 오래 기다리지 않는다(실행 기록은 대화와 분리되어 남는다)
  await Promise.race([stopConversation(id), new Promise(r => setTimeout(r, 1500))]);
  await repo.deleteConversation(id);
  return c.json({ ok: true });
});
app.post('/conversations/:id/files', async c => {
  const id = c.req.param('id'), repo = repository();
  await repo.conversation(id);
  const form = await c.req.formData();
  const results = [];
  for (const file of form.getAll('files')) if (file instanceof File) results.push(await attach(repo, id, file));
  if (!results.length) return c.json({ error: '첨부 파일 없음' }, 400);
  return c.json({ files: results }, 201);
});
app.get('/conversations/:id/files/:file', async c => {
  const file = await repository().one('SELECT * FROM artifacts WHERE id=? AND conversation_id=?', c.req.param('file'), c.req.param('id'));
  if (!file) return c.json({ error: '파일 없음' }, 404);
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(await repository().ensureFile(repository().path(c.req.param('id'), file.name)));
  if (hash(bytes) !== file.hash) throw new Error('다운로드 파일 해시 불일치');
  return new Response(bytes, { headers: { 'content-type': file.kind === 'document' ? file.mime : 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.split('/').at(-1))}`, 'x-content-type-options': 'nosniff' } });
});
app.get('/runs/:id', async c => {
  const repo = repository(), run = await repo.one('SELECT * FROM runs WHERE id=?', c.req.param('id'));
  if (!run) return c.json({ error: '조사 실행 없음' }, 404);
  return c.json({ ...run, result: run.result ? JSON.parse(run.result) : null, queued: run.conversation_id ? await repo.queuedMessages(run.conversation_id) : [], events: (await repo.all('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id', run.id, Number(c.req.query('after') || 0))).map((e: any) => ({ ...e, data: JSON.parse(e.data) })) });
});
app.post('/runs/:id/stop', async c => { await stopRun(c.req.param('id')); return c.json({ ok: true }); });
app.post('/tools/:name', async c => {
  const name = c.req.param('name'), body = await c.req.json().catch(() => ({}));
  if (body.args || !TOOL_IMPLS[name]) {
    if (!TOOL_DEFS.some(d => d.name === name)) return c.json({ error: 'unknown tool' }, 404);
    return c.json(await executeTool(name, body.args || body, { conversationId: body.conversationId, env: c.env ?? {}, appContext: body.appContext }));
  }
  return c.json(await TOOL_IMPLS[name](body));
});
app.post('/chat', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return c.json({ error: '잘못된 요청' }, 400);
  const run = await startRun(body, c.env ?? {});
  if (body.conversationId) return c.json({ runId: run.runId, conversationId: run.conversationId }, 202);
  await run.done;
  const row = await repository().one('SELECT result,error FROM runs WHERE id=?', run.runId);
  return c.json(row.result ? JSON.parse(row.result) : { error: row.error });
});
app.notFound(c => c.json({ error: 'not found' }, 404));

export default app;
