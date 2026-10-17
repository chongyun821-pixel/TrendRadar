import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Repository, repository, now } from '../server/store';
import { startRun, recoverRuns } from '../server/runs';
import * as models from '../server/models';
import { app } from '../server/app';
import type { ChatIn } from '../server/agent';

afterEach(() => vi.restoreAllMocks());
const input = (conversationId: string, text: string): ChatIn => ({ conversationId, model: 'gemma', messages: [{ role: 'user', text }] });
const reply = (text: string) => ({ reply: text, reports: [], actions: [], tools: [] });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

describe('대화별 영속 요청 대기열', () => {
  it('앞선 답변 뒤에 순서대로 실행하고 미래 요청을 앞선 모델 문맥에 넣지 않는다', async () => {
    const repo = repository(), c = await repo.createConversation(), firstGate = gate(), entered = gate();
    const calls: ChatIn[] = [];
    vi.spyOn(models, 'chatWith').mockImplementation(async request => {
      calls.push(structuredClone({ ...request, signal: undefined }));
      if (calls.length === 1) { entered.release(); await firstGate.promise; }
      return reply(`답변 ${request.messages.at(-1)!.text}`);
    });
    const first = await startRun(input(c.id, '첫 요청'), {}); await entered.promise;
    const second = await startRun(input(c.id, '둘째 요청'), {});
    const third = await startRun(input(c.id, '셋째 요청'), {});
    expect((await repo.conversation(c.id)).queued.map((q: { text: string }) => q.text)).toEqual(['둘째 요청', '셋째 요청']);
    const fresh = new Repository(repo.file, repo.storage);
    try { expect((await fresh.conversation(c.id)).queued.map((q: { id: string }) => q.id)).toEqual([second.runId, third.runId]); }
    finally { await fresh.close(); }
    expect(calls).toHaveLength(1);
    firstGate.release(); await Promise.all([first.done, second.done, third.done]);
    expect(calls.map(c => c.messages.at(-1)!.text)).toEqual(['첫 요청', '둘째 요청', '셋째 요청']);
    expect(calls[1].messages.map(m => m.text)).toEqual(['첫 요청', '답변 첫 요청', '둘째 요청']);
    expect((await repo.conversation(c.id)).messages.map((m: { text: string }) => m.text)).toEqual(['첫 요청', '답변 첫 요청', '둘째 요청', '답변 둘째 요청', '셋째 요청', '답변 셋째 요청']);
  });

  it('동시 접수한 요청을 빠뜨리지 않고 대화마다 하나씩 실행한다', async () => {
    const repo = repository(), c = await repo.createConversation();
    let active = 0, peak = 0;
    const seen: string[] = [];
    vi.spyOn(models, 'chatWith').mockImplementation(async request => {
      active++; peak = Math.max(peak, active); seen.push(request.messages.at(-1)!.text);
      await new Promise(resolve => setTimeout(resolve, 15)); active--;
      return reply('처리 완료');
    });
    const runs = await Promise.all(['A', 'B', 'C', 'D'].map(text => startRun(input(c.id, text), {})));
    await Promise.all(runs.map(r => r.done));
    expect(peak).toBe(1); expect(seen).toHaveLength(4); expect(new Set(seen)).toEqual(new Set(['A', 'B', 'C', 'D']));
    expect((await repo.conversation(c.id)).queued).toEqual([]);
  });

  it('다른 프로세스의 중지 후 대기를 이어서 처리하고 중지된 모델의 늦은 답변은 저장하지 않는다', async () => {
    const repo = repository(), c = await repo.createConversation(), firstGate = gate(), entered = gate();
    let calls = 0;
    vi.spyOn(models, 'chatWith').mockImplementation(async () => {
      if (++calls === 1) { entered.release(); await firstGate.promise; return reply('저장되면 안 되는 늦은 답변'); }
      return reply('다음 답변');
    });
    const first = await startRun(input(c.id, '중지 대상'), {}); await entered.promise;
    const next = await startRun(input(c.id, '후속 요청'), {});
    await repo.run("UPDATE runs SET status='stopping' WHERE id=?", first.runId);
    firstGate.release(); await first.done; await next.done;
    expect((await repo.one('SELECT status FROM runs WHERE id=?', first.runId)).status).toBe('cancelled');
    const messages = (await repo.conversation(c.id)).messages.map((m: { text: string }) => m.text);
    expect(messages).not.toContain('저장되면 안 되는 늦은 답변'); expect(messages.at(-1)).toBe('다음 답변');
  });

  it('재시작 때 미실행 요청과 접수 당시 문맥을 복원하며 대화 삭제는 대기도 취소한다', async () => {
    const repo = repository(), c = await repo.createConversation(), runId = randomUUID();
    const request = { ...input(c.id, '복원할 요청'), state: { focus: 'SAU', mode: 'ifv' } };
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'gemma', 'queued', now());
    await repo.event(runId, 'run.queued', request);
    const called = vi.spyOn(models, 'chatWith').mockResolvedValue(reply('복원 후 답변'));
    await recoverRuns({});
    await vi.waitFor(async () => expect((await repo.one('SELECT status FROM runs WHERE id=?', runId)).status).toBe('completed'));
    expect(called.mock.calls[0][0].state).toEqual({ focus: 'SAU', mode: 'ifv' });
    const blocker = randomUUID(), pending = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', blocker, c.id, 'mcp', 'running', now());
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', pending, c.id, 'gemma', 'queued', now());
    await repo.event(pending, 'run.queued', input(c.id, '삭제 전 대기'));
    expect((await app.request(`/api/conversations/${c.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await repo.one('SELECT id FROM conversations WHERE id=?', c.id)).toBeUndefined();
    expect(await repo.one('SELECT status,conversation_id FROM runs WHERE id=?', pending)).toMatchObject({ status: 'cancelled', conversation_id: null });
    expect(await repo.one("SELECT data FROM events WHERE run_id=? AND name='run.queued'", pending)).toBeDefined();
  });
});
