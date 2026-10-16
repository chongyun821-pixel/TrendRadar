import { Hono } from 'hono';
import type { Env } from './gemma';
import { listModels, DEFAULT_MODEL } from './models';
import { TOOL_IMPLS, listForecasts, writeReport } from '../shared/tools';
import { seed } from '../shared/data';
import { repository } from './store';
import { startRun, stopRun } from './runs';
import { attach } from './attachments';
import { bodyLimit } from 'hono/body-limit';

export const app = new Hono<{ Bindings: Env }>().basePath('/api');
app.use('*', bodyLimit({ maxSize: 40 * 1024 * 1024, onError: c => c.json({ error: '첨부는 요청당 40MB까지 가능합니다' }, 413) }));
app.onError((e, c) => c.json({ error: e.message }, /찾을 수|파일 없음/.test(e.message) ? 404 : /진행 중|충돌/.test(e.message) ? 409 : 400));

app.get('/health', c => c.json({ ok: true, ai: !!c.env?.GOOGLE_API_KEY, openrouter: !!c.env?.OPENROUTER_API_KEY, model: c.env?.GEMMA_MODEL || 'gemma-4-26b-a4b-it', records: seed.records.length }));
app.get('/models', async c => c.json({ default: DEFAULT_MODEL, models: await listModels(c.env ?? {}) }));
app.get('/forecasts', c => c.json(listForecasts({ system: c.req.query('system') ?? undefined, limit: 100 })));
app.get('/report', c => { const r = writeReport({ country: c.req.query('country'), system: c.req.query('system') }); return 'error' in r ? c.json(r, 404) : c.text(r.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' }); });
app.get('/data', c => c.json(repository().data(), 200, { 'cache-control': 'no-store', 'x-data-version': String(repository().revision()) }));
app.get('/data/version', c => c.json({ revision: repository().revision() }, 200, { 'cache-control': 'no-store' }));
app.get('/conversations', c => c.json(repository().all('SELECT * FROM conversations ORDER BY updated_at DESC')));
app.post('/conversations', c => c.json(repository().createConversation(), 201));
app.get('/conversations/:id', c => c.json(repository().conversation(c.req.param('id'))));
app.delete('/conversations/:id', async c => {
  const id = c.req.param('id'), repo = repository();
  repo.conversation(id);
  for (const run of repo.all("SELECT id FROM runs WHERE conversation_id=? AND status IN ('running','stopping')", id)) await stopRun(run.id);
  repo.deleteConversation(id);
  return c.json({ ok: true });
});
app.post('/conversations/:id/files', async c => {
  const id = c.req.param('id'), repo = repository();
  repo.conversation(id);
  const form = await c.req.formData();
  const results = [];
  for (const file of form.getAll('files')) if (file instanceof File) results.push(await attach(repo, id, file));
  if (!results.length) return c.json({ error: '첨부 파일 없음' }, 400);
  return c.json({ files: results }, 201);
});
app.get('/conversations/:id/files/:file', async c => {
  const file = repository().one('SELECT * FROM artifacts WHERE id=? AND conversation_id=?', c.req.param('file'), c.req.param('id'));
  if (!file) return c.json({ error: '파일 없음' }, 404);
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(repository().path(c.req.param('id'), file.name, true));
  return new Response(bytes, { headers: { 'content-type': file.kind === 'document' ? file.mime : 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.split('/').at(-1))}`, 'x-content-type-options': 'nosniff' } });
});
app.get('/runs/:id', c => {
  const repo = repository(), run = repo.one('SELECT * FROM runs WHERE id=?', c.req.param('id'));
  if (!run) return c.json({ error: '조사 실행 없음' }, 404);
  return c.json({ ...run, result: run.result ? JSON.parse(run.result) : null, events: repo.all('SELECT * FROM events WHERE run_id=? AND id>? ORDER BY id', run.id, Number(c.req.query('after') || 0)).map((e: any) => ({ ...e, data: JSON.parse(e.data) })) });
});
app.post('/runs/:id/stop', async c => { await stopRun(c.req.param('id')); return c.json({ ok: true }); });
app.post('/tools/:name', async c => {
  const f = TOOL_IMPLS[c.req.param('name')];
  if (!f) return c.json({ error: 'unknown tool' }, 404);
  const args = await c.req.json().catch(() => ({}));
  return c.json(await f(args));
});
app.post('/chat', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return c.json({ error: '잘못된 요청' }, 400);
  const run = startRun(body, c.env ?? {});
  if (body.conversationId) return c.json({ runId: run.runId, conversationId: run.conversationId }, 202);
  await run.done;
  const row = repository().one('SELECT result,error FROM runs WHERE id=?', run.runId);
  return c.json(row.result ? JSON.parse(row.result) : { error: row.error });
});
app.notFound(c => c.json({ error: 'not found' }, 404));

export default app;
