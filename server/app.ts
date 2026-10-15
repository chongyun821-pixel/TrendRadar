import { Hono } from 'hono';
import type { Env } from './gemma';
import { chatWith, listModels, DEFAULT_MODEL } from './models';
import { TOOL_IMPLS, listForecasts, writeReport } from '../shared/tools';
import { seed } from '../shared/data';

export const app = new Hono<{ Bindings: Env }>().basePath('/api');

app.get('/health', c => c.json({ ok: true, ai: !!c.env?.GOOGLE_API_KEY, openrouter: !!c.env?.OPENROUTER_API_KEY, model: c.env?.GEMMA_MODEL || 'gemma-4-26b-a4b-it', records: seed.records.length }));
app.get('/models', async c => c.json({ default: DEFAULT_MODEL, models: await listModels(c.env ?? {}) }));
app.get('/forecasts', c => c.json(listForecasts({ system: c.req.query('system') ?? undefined, limit: 100 })));
app.get('/report', c => { const r = writeReport({ country: c.req.query('country'), system: c.req.query('system') }); return 'error' in r ? c.json(r, 404) : c.text(r.markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' }); });
app.get('/data', c => c.json(seed));
app.post('/tools/:name', async c => {
  const f = TOOL_IMPLS[c.req.param('name')];
  if (!f) return c.json({ error: 'unknown tool' }, 404);
  const args = await c.req.json().catch(() => ({}));
  return c.json(f(args));
});
app.post('/chat', async c => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return c.json({ error: '잘못된 요청' }, 400);
  try { return c.json(await chatWith(body, c.env ?? {})); }
  catch (e) { return c.json({ error: '서버 오류', detail: String(e).slice(0, 200) }, 500); }
});
app.notFound(c => c.json({ error: 'not found' }, 404));

export default app;
