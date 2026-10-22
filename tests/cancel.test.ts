import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { repository } from '../server/store';
import { startRun, stopRun, runSettings, STOPPED_MESSAGE } from '../server/runs';
import { runProcess } from '../server/process';
import * as models from '../server/models';
import { app } from '../server/app';
import type { ChatIn } from '../server/agent';
import type { Env } from '../server/env';

const FAKE = resolve('tests/fixtures/fake-cli.mjs');
const runtime = mkdtempSync(join(tmpdir(), 'radar-cli-runtime-'));
const cliEnv: Env = { GROK_BIN: FAKE, CODEX_BIN: FAKE, CLI_RUNTIME_DIR: runtime };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const status = async (runId: string) => (await repository().one('SELECT status,error FROM runs WHERE id=?', runId));
const texts = async (id: string): Promise<string[]> => (await repository().conversation(id)).messages.map((m: { role: string; text: string }) => `${m.role}:${m.text}`);
async function waitFor<T>(f: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`시간 초과: ${JSON.stringify(v)}`); await new Promise(r => setTimeout(r, 25)); }
}
const grace = runSettings.stopGraceMs;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); runSettings.stopGraceMs = grace; });

describe('CLI 프로세스 트리 중지', () => {
  it('중지하면 SIGTERM을 무시하고 출력 파이프를 붙잡은 손자 프로세스까지 종료하고 바로 끝난다', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'radar-proc-'));
    const controller = new AbortController(), lines: string[] = [];
    const started = Date.now();
    writeFileSync(join(cwd, 'p.txt'), '사용자: 멈춤');
    const result = runProcess(process.execPath, [FAKE, '--prompt-file', join(cwd, 'p.txt')], { cwd, signal: controller.signal, graceMs: 300, onData: line => { lines.push(line); } });
    await waitFor(() => existsSync(join(cwd, 'fake-cli.pids')) && lines.length > 0, v => v);
    const pids: number[] = JSON.parse(readFileSync(join(cwd, 'fake-cli.pids'), 'utf8'));
    expect(pids.every(alive)).toBe(true);
    controller.abort();
    const r = await result;
    expect(r.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
    await waitFor(() => pids.filter(alive), left => left.length === 0, 3000);
  });
});

describe('대화 요청 중지', { timeout: 15000 }, () => {
  it('그록 빌드 실행을 중지하면 CLI 트리를 끝내고 중지됨으로 저장한 뒤 바로 다음 요청을 처리한다', async () => {
    const repo = repository(), c = await repo.createConversation();
    const first = await startRun({ conversationId: c.id, model: 'grok', messages: [{ role: 'user', text: '멈춤 테스트' }] }, cliEnv);
    const pidFile = join(repo.workspace(c.id), 'fake-cli.pids');
    await waitFor(() => existsSync(pidFile), v => v);
    const pids: number[] = JSON.parse(readFileSync(pidFile, 'utf8'));
    expect((await status(first.runId)).status).toBe('running');
    const queued = await startRun({ conversationId: c.id, model: 'grok', options: { model: 'grok-4.5' }, messages: [{ role: 'user', text: '다음 요청' }] }, cliEnv);
    const stopped = Date.now();
    await stopRun(first.runId);
    expect(Date.now() - stopped).toBeLessThan(5000);
    expect(await status(first.runId)).toMatchObject({ status: 'cancelled', error: STOPPED_MESSAGE });
    await waitFor(() => pids.filter(alive), left => left.length === 0, 4000);
    await queued.done;
    expect((await status(queued.runId)).status).toBe('completed');
    const messages = await texts(c.id);
    expect(messages.slice(0, 3)).toEqual(['user:멈춤 테스트', `model:${STOPPED_MESSAGE}`, 'user:다음 요청']);
    expect(messages[3]).toContain('"grok-4.5"');
    expect(messages.filter((m: string) => m === `model:${STOPPED_MESSAGE}`)).toHaveLength(1);
  });

  it('중지 신호를 무시하는 모델도 유예 시간 뒤 중지로 확정하고 늦은 답변은 저장하지 않는다', async () => {
    runSettings.stopGraceMs = 200;
    const repo = repository(), c = await repo.createConversation();
    let release!: () => void; const late = new Promise<void>(r => { release = r; });
    let calls = 0;
    vi.spyOn(models, 'chatWith').mockImplementation(async () => {
      if (++calls === 1) { await late; return { reply: '늦은 답변', reports: [], actions: [], tools: [] }; }
      return { reply: '다음 답변', reports: [], actions: [], tools: [] };
    });
    const first = await startRun({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text: '오래 걸림' }] }, {});
    await waitFor(() => calls, n => n === 1);
    const next = await startRun({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text: '바로 다음' }] }, {});
    await stopRun(first.runId);
    expect((await status(first.runId)).status).toBe('cancelled');
    await next.done;
    release(); await first.done;
    await new Promise(r => setTimeout(r, 50));
    const messages = await texts(c.id);
    expect(messages).toEqual(['user:오래 걸림', `model:${STOPPED_MESSAGE}`, 'user:바로 다음', 'model:다음 답변']);
    expect((await status(first.runId)).status).toBe('cancelled');
  });

  it('지피티 요청을 중지하면 진행 중인 OpenAI HTTP 호출을 끊는다', async () => {
    const repo = repository(), c = await repo.createConversation();
    let aborted = false, entered!: () => void; const inFlight = new Promise<void>(r => { entered = r; });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      entered();
      init.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true });
    })));
    const run = await startRun({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text: '조사해 줘' }] }, { OPENAI_API_KEY: 'test-key' });
    await inFlight;
    const response = await app.request(`/api/runs/${run.runId}/stop`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(aborted).toBe(true);
    expect(await status(run.runId)).toMatchObject({ status: 'cancelled', error: STOPPED_MESSAGE });
    expect(await texts(c.id)).toEqual(['user:조사해 줘', `model:${STOPPED_MESSAGE}`]);
  });

  it('대기 중인 요청을 취소하면 실행하지 않고 사용자 메시지도 남기지 않는다', async () => {
    const repo = repository(), c = await repo.createConversation();
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const seen: string[] = [];
    vi.spyOn(models, 'chatWith').mockImplementation(async request => { seen.push(request.messages.at(-1)!.text); if (seen.length === 1) await gate; return { reply: '답', reports: [], actions: [], tools: [] }; });
    const first = await startRun({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text: '먼저' }] }, {});
    await waitFor(() => seen.length, n => n === 1);
    const queued = await startRun({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text: '취소할 대기' }] }, {});
    await stopRun(queued.runId);
    release(); await first.done; await queued.done;
    expect(seen).toEqual(['먼저']);
    expect((await status(queued.runId)).status).toBe('cancelled');
    expect(await texts(c.id)).toEqual(['user:먼저', 'model:답']);
  });
});

describe('대화별 모델 선택이 실제 호출까지 전달된다', { timeout: 15000 }, () => {
  async function chat(conversationId: string, body: Partial<ChatIn> & { options?: unknown }, env: Env) {
    const r = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId, messages: [{ role: 'user', text: '모델 확인' }], ...body }) }, env);
    expect(r.status).toBe(202);
    const { runId } = await r.json() as { runId: string };
    await waitFor(() => status(runId), row => !['queued', 'running', 'stopping'].includes(row.status));
    return repository().one("SELECT text,payload FROM messages WHERE conversation_id=? AND role='model' ORDER BY rowid DESC LIMIT 1", conversationId);
  }
  const argsOf = (text: string): string[] => JSON.parse(text.replace(/^ARGS /, ''));
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('같은 대화에서 그록 빌드 → 코덱스 → 지피티로 바꾸면 다음 요청의 CLI 인자·API 모델이 바뀐다', async () => {
    const c = await repository().createConversation();
    const grok = await chat(c.id, { model: 'grok', options: { model: 'grok-4.6', effort: 'low' } }, cliEnv);
    const g = argsOf(grok.text);
    expect([value(g, '-m'), value(g, '--reasoning-effort')]).toEqual(['grok-4.6', 'low']);
    expect(JSON.parse(grok.payload).model).toBe('grok-4.6');

    const codex = await chat(c.id, { model: 'codex', options: { model: 'gpt-6-astra', effort: 'max' } }, cliEnv);
    const x = argsOf(codex.text);
    expect(x[0]).toBe('exec');
    expect(value(x, '-m')).toBe('gpt-6-astra');
    expect(x).toContain('model_reasoning_effort="max"');

    // 세부 선택 없이 고르면 환경 변수 기본값, 없으면 앱 기본값을 쓴다.
    const fallback = argsOf((await chat(c.id, { model: 'grok' }, { ...cliEnv, GROK_EFFORT: 'medium' })).text);
    expect([value(fallback, '-m'), value(fallback, '--reasoning-effort')]).toEqual(['grok-4.7', 'medium']);

    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '지피티 답' }] }] }), { status: 200 });
    }));
    const gpt = await chat(c.id, { model: 'gpt' }, { ...cliEnv, OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-test-model' });
    expect(gpt.text).toBe('지피티 답');
    expect(bodies.at(-1).model).toBe('gpt-test-model');
    const runs = await repository().all('SELECT model FROM runs WHERE conversation_id=? ORDER BY rowid', c.id);
    expect(runs.map(r => r.model)).toEqual(['grok', 'codex', 'grok', 'gpt']);
  });

  it('허용하지 않는 조합은 접수하지 않는다', async () => {
    const c = await repository().createConversation();
    const r = await app.request('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversationId: c.id, model: 'grok', options: { model: 'gpt-6-astra' }, messages: [{ role: 'user', text: 'x' }] }) }, cliEnv);
    expect(r.status).toBe(400);
  });
});
