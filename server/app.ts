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
import { saveAppContext, readAppContext, pendingCommands, acknowledgeCommand, reportTarget } from './app-context';
import { TOOL_DEFS } from './agent';
import { executeTool } from './tool-session';
import { scoreSystem, scoreSummary } from './scoring';
import { resolveSystem } from '../shared/data';

export const app = new Hono<{ Bindings: Env }>().basePath('/api');
app.use('*', bodyLimit({ maxSize: 40 * 1024 * 1024, onError: c => c.json({ error: '첨부는 요청당 40MB까지 가능합니다' }, 413) }));
app.use('*', async (_c, next) => { await repository().data(); await next(); });
app.onError((e, c) => c.json({ error: e.message }, /찾을 수|파일 없음/.test(e.message) ? 404 : /진행 중|충돌/.test(e.message) ? 409 : 400));

app.get('/health', c => c.json({ ok: true, storage: repository().kind, ai: !!c.env?.OPENAI_API_KEY, openrouter: !!c.env?.OPENROUTER_API_KEY, model: c.env?.OPENAI_MODEL || GPT_MODEL, records: seed.records.length }));
app.get('/models', async c => {
  const env = c.env ?? {}, models = await listModels(env);
  // defaults: 세부 선택이 없을 때 서버가 실제로 쓰는 CLI 모델·추론 강도(환경 변수 반영). 상태 줄 표시용
  return c.json({ default: defaultModel(env, models), models, defaults: { grok: cliChoice('grok', env), codex: cliChoice('codex', env) } });
});
app.get('/forecasts', c => c.json(listForecasts({ system: c.req.query('system') ?? undefined, limit: 100 })));
app.get('/scores', async c => {
  const system = resolveSystem(c.req.query('system'));
  if (!system) return c.json({ error: '체계를 지정하세요' }, 400);
  const repo = repository(), snapshot = await repo.versionedData();
  return c.json({ revision: snapshot.revision, system, scores: (await scoreSystem(repo, snapshot.data, system)).map(scoreSummary) }, 200, { 'cache-control': 'no-store' });
});
app.get('/report', c => { const r = writeReport({ country: c.req.query('country'), system: c.req.query('system') }); return 'error' in r ? c.json(r, 404) : c.text(r.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' }); });
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
  return c.json({ ...conversation, reportEntries: reports.map(r => ({ id: r.id, ...reportTarget(r.markdown), kind: 'country-analysis', basisDate: r.basis_date, dataVersion: r.data_version, createdAt: r.created_at, markdown: r.markdown })) });
});
app.post('/app-context', async c => c.json(await saveAppContext(repository(), await c.req.json())));
app.get('/app-context/:screen', async c => c.json(await readAppContext(repository(), c.req.param('screen')), 200, { 'cache-control': 'no-store' }));
app.get('/app-context/:screen/commands', async c => c.json(await pendingCommands(repository(), c.req.param('screen')), 200, { 'cache-control': 'no-store' }));
app.post('/app-context/:screen/commands/:id', async c => c.json(await acknowledgeCommand(repository(), c.req.param('screen'), c.req.param('id'), await c.req.json())));
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
