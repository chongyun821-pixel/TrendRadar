import express from 'express';
import multer from 'multer';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store, AppError, containedPath } from './store';
import { RadarReader } from './radar';
import { Agent } from './agent';
import { config, ROOT, safeError } from './config';
import { MODEL, EFFORT, PAGE_DEFS } from '../shared/types';
import { addAttachment } from './attachments';
import { reportHtml, exportPdf, exportWord } from './export';
import { EphemeralChat } from './ephemeral-chat';
import { exampleList, createExample, EXAMPLE_OPENING } from './examples';
const app = express(), store = new Store(), radar = new RadarReader(), agent = new Agent(store, radar);
const chat = new EphemeralChat(store, agent);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 8 } });
app.disable('x-powered-by');
app.use((req, res, next) => {
  const allowed = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, `[::1]:${config.port}`]);
  if (!allowed.has(req.headers.host || '')) return res.status(403).json({ error: '로컬 주소에서 접근해주세요.' });
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`].includes(origin)) return res.status(403).json({ error: '허용되지 않은 출처입니다.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '3mb' }));
app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL, effort: EFFORT, storage: 'h5s-local', radarAccess: 'read-only', chatTransport: 'exec-ephemeral', reportTransport: 'app-server' }));
let statusPromise: Promise<any> | undefined, statusTime = 0;
app.get('/api/connections', async (req, res) => {
  if (!statusPromise || Date.now() - statusTime > 30000 || req.query.refresh) {
    statusTime = Date.now(); statusPromise = Promise.all([agent.bridge.status(), radar.status()]).then(([codex, radar]) => ({ codex, radar, model: MODEL, effort: EFFORT }));
  }
  res.json(await statusPromise);
});
app.get('/api/reports', (_req, res) => res.json(store.list().map(r => ({ id: r.id, title: r.title, mode: r.mode || 'report', createdAt: r.createdAt, updatedAt: r.updatedAt, confirmed: r.pages.filter(p => p.status === 'confirmed').length }))));
app.get('/api/examples', (_req, res) => res.json(exampleList()));
app.post('/api/examples/:example', async (req, res) => {
  const report = await createExample(store, req.params.example);
  chat.start(report.id, EXAMPLE_OPENING);
  res.status(201).json(agent.state(report.id));
});
app.post('/api/chats', (req, res) => {
  const { text } = z.object({ text: z.string().max(40000).default('') }).parse(req.body);
  const conversation = store.createChat();
  if (text.trim()) chat.start(conversation.id, text);
  res.status(201).json(agent.state(conversation.id));
});
app.post('/api/reports', async (req, res) => {
  const input = z.object({ title: z.string().max(160).default('새로운 컨설팅 과제'), context: z.string().max(40000).default(''), radarConversationId: z.string().nullable().optional() }).parse(req.body);
  const context = input.radarConversationId ? await radar.conversation(input.radarConversationId) : null;
  const report = store.create(input.title, input.context, input.radarConversationId || null);
  if (context) {
    writeFileSync(join(store.workspace(report.id), 'radar-context.json'), JSON.stringify(context, null, 2), 'utf8');
    store.message(report.id, 'system', `기존 대화 「${context.conversation.title}」의 전체 메시지 ${context.messages.length}개와 자료 목록을 연결했습니다. 기존 프로젝트는 읽기 전용입니다.`);
  }
  res.status(201).json(agent.state(report.id));
});
app.get('/api/reports/:id', (req, res) => res.json(agent.state(req.params.id)));
app.delete('/api/reports/:id', (req, res) => {
  const id = req.params.id;
  if (agent.active.has(id) || chat.active.has(id)) throw new AppError('답변을 중지하거나 작성이 끝난 뒤 대화를 삭제해주세요.', 409);
  store.delete(id);
  agent.emit(id, { seq: 0, event: { type: 'deleted', data: { id } } });
  res.json({ deleted: true, id });
});
app.patch('/api/reports/:id', (req, res) => {
  const data = z.object({ title: z.string().min(1).max(160).optional(), context: z.string().max(40000).optional(), currentPage: z.enum(PAGE_DEFS.map(p => p.id) as [string, ...string[]]).optional() }).parse(req.body);
  store.change(req.params.id, r => { if (data.currentPage) store.assertUnlocked(r, data.currentPage); Object.assign(r, data); });
  agent.changed(req.params.id); res.json(agent.state(req.params.id));
});
app.patch('/api/reports/:id/pages/:page', (req, res) => {
  const data = z.object({ content: z.string().max(30000).optional(), expectedVersion: z.number().int().min(0), answers: z.record(z.string().max(10000)).optional() }).parse(req.body);
  const current = store.get(req.params.id); store.assertUnlocked(current, req.params.page);
  store.updateDraft(req.params.id, req.params.page, data.content ?? current.pages.find(p => p.id === req.params.page)!.content, data.expectedVersion, 'human', '', data.answers);
  agent.changed(req.params.id); res.json(agent.state(req.params.id));
});
app.post('/api/reports/:id/pages/:page/confirm', (req, res) => {
  if (agent.active.has(req.params.id)) throw new AppError('Codex 작성이 끝난 뒤 확정해주세요.', 409);
  const { expectedVersion } = z.object({ expectedVersion: z.number().int() }).parse(req.body);
  store.confirm(req.params.id, req.params.page, expectedVersion); agent.changed(req.params.id); res.json(agent.state(req.params.id));
});
app.post('/api/reports/:id/run', (req, res) => {
  const input = z.object({ pageId: z.string(), action: z.enum(['questions', 'draft', 'chat']), text: z.string().max(40000).default('') }).parse(req.body);
  if (input.action === 'chat' && !input.text.trim()) throw new AppError('메시지를 입력해주세요.');
  if (store.get(req.params.id).mode === 'chat') {
    if (input.action !== 'chat') throw new AppError('채팅에서 작성할 내용을 알려주세요.');
    return res.status(202).json({ run: chat.start(req.params.id, input.text) });
  }
  if (chat.active.has(req.params.id)) throw new AppError('답변을 기다리거나 중지해주세요.', 409);
  res.status(202).json({ run: agent.start(req.params.id, input.pageId, input.action, input.text) });
});
app.post('/api/reports/:id/stop', async (req, res) => { if (chat.active.has(req.params.id)) await chat.cancel(req.params.id); else await agent.cancel(req.params.id); res.json(agent.state(req.params.id)); });
app.post('/api/reports/:id/proposals/:proposal', (req, res) => {
  const data = z.object({ accept: z.boolean(), expectedVersion: z.number().int() }).parse(req.body);
  const report = store.get(req.params.id), proposal = report.proposals.find(p => p.id === req.params.proposal);
  if (!proposal) throw new AppError('제안을 찾을 수 없습니다.', 404);
  if (data.accept) { store.assertUnlocked(report, proposal.pageId); store.updateDraft(report.id, proposal.pageId, proposal.content, data.expectedVersion, 'human'); }
  store.change(report.id, r => { r.proposals = r.proposals.filter(p => p.id !== proposal.id); }); agent.changed(report.id); res.json(agent.state(report.id));
});
app.get('/api/reports/:id/events', (req, res) => {
  store.get(req.params.id);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  const after = Number(req.headers['last-event-id'] || req.query.after || 0);
  const send = (seq: number, data: string) => res.write(`id: ${seq}\ndata: ${data}\n\n`);
  // Register before replay; JavaScript does not yield between subscription and replay.
  const listener = ({ seq, event }: any) => { send(seq, JSON.stringify(event)); if (event.type === 'deleted') res.end(); };
  agent.on(req.params.id, listener);
  for (const event of store.events(req.params.id, Number.isFinite(after) ? after : 0)) send(event.seq, event.data);
  res.write(`data: ${JSON.stringify({ type: 'snapshot', data: agent.state(req.params.id) })}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); agent.off(req.params.id, listener); });
});
app.post('/api/reports/:id/attachments', upload.array('files', 8), async (req, res) => {
  const id = String(req.params.id);
  store.get(id);
  for (const file of req.files as Express.Multer.File[]) {
    const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    if (!/\.(txt|md|csv|tsv|json|pdf|docx|png|jpe?g|webp)$/i.test(name)) throw new AppError('PDF, Word, 텍스트, 이미지 파일을 첨부해주세요.');
    await addAttachment(store, id, name, file.mimetype, file.buffer);
  }
  agent.changed(id); res.json(agent.state(id));
});
app.get('/api/reports/:id/files/:attachment', (req, res) => {
  const report = store.get(req.params.id), a = report.attachments.find(a => a.id === req.params.attachment);
  if (!a) throw new AppError('자료를 찾을 수 없습니다.', 404);
  res.download(containedPath(store.workspace(report.id), a.path, true), a.name, { dotfiles: 'allow' });
});
app.get('/api/radar/conversations', async (req, res) => res.json(await radar.conversations(String(req.query.q || ''))));
app.get('/api/radar/search', async (req, res) => res.json(await radar.search(String(req.query.q || ''), z.enum(['records', 'sources', 'reports']).parse(req.query.kind || 'records'))));
app.post('/api/reports/:id/radar', async (req, res) => {
  if (agent.active.has(req.params.id) || chat.active.has(req.params.id)) throw new AppError('답변 종료 후 대화를 연결해주세요.', 409);
  const { conversationId } = z.object({ conversationId: z.string().min(1) }).parse(req.body);
  const context = await radar.conversation(conversationId);
  writeFileSync(join(store.workspace(req.params.id), 'radar-context.json'), JSON.stringify(context, null, 2), 'utf8');
  store.change(req.params.id, r => { r.radarConversationId = conversationId; });
  store.message(req.params.id, 'system', `기존 대화 「${context.conversation.title}」의 전체 메시지 ${context.messages.length}개와 자료 목록을 연결했습니다.`);
  agent.changed(req.params.id); res.json({ ...agent.state(req.params.id), context });
});
app.get('/api/reports/:id/radar-files', async (req, res) => {
  const report = store.get(req.params.id); res.json(report.radarConversationId ? (await radar.conversation(report.radarConversationId)).artifacts : []);
});
app.post('/api/reports/:id/radar-files/:artifact', async (req, res) => {
  const report = store.get(req.params.id);
  if (!report.radarConversationId) throw new AppError('기존 대화를 먼저 연결해주세요.');
  const file = await radar.file(report.radarConversationId, req.params.artifact);
  await addAttachment(store, report.id, file.name, file.mime, file.bytes); agent.changed(report.id); res.json(agent.state(report.id));
});
app.get('/api/reports/:id/export/:format', async (req, res) => {
  const report = store.get(req.params.id), format = req.params.format;
  const name = report.title.replace(/[^\p{L}\p{N} _-]/gu, '_').slice(0, 100) || 'H5S 보고서';
  if (format === 'html') {
    res.type('html'); if (req.query.download) res.attachment(`${name}.html`); res.send(reportHtml(report)); return;
  }
  if (!['pdf', 'docx'].includes(format)) throw new AppError('지원하지 않는 내보내기 형식입니다.');
  const bytes = await store.withFiles(report.id, async () => {
    const bytes = format === 'pdf' ? await exportPdf(report) : await exportWord(report);
    const root = join(store.workspace(report.id), 'exports'); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, `${Date.now()}-${name}.${format}`), bytes);
    return bytes;
  });
  res.attachment(`${name}.${format}`).type(format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(bytes);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'API를 찾을 수 없습니다.' }));
if (existsSync(join(ROOT, 'dist/index.html')) && process.env.NODE_ENV !== 'development') {
  app.use(express.static(join(ROOT, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(join(ROOT, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' }); app.use(vite.middlewares);
}
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err instanceof AppError ? err.status : err instanceof z.ZodError ? 400 : 500;
  res.status(status).json({ error: err instanceof z.ZodError ? '입력 형식을 확인해주세요.' : safeError(err) });
});
const server = app.listen(config.port, '127.0.0.1', () => console.log(`H5S Studio · http://127.0.0.1:${config.port}\nCodex ${MODEL} · ${EFFORT} / procurement-radar 읽기 전용`));
async function shutdown() { await chat.stopAll(); agent.bridge.stop(); await radar.close(); store.close(); server.close(); process.exit(0); }
process.on('SIGINT', () => { void shutdown(); }); process.on('SIGTERM', () => { void shutdown(); });
