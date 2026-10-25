import { describe, it, expect, vi, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { repository } from '../server/store';
import { app } from '../server/app';
import { attachedReports } from '../server/viewed-reports';

async function waitDone(runId: string) {
  for (let i = 0; i < 300; i++) {
    const row = await repository().one('SELECT status FROM runs WHERE id=?', runId);
    if (!['queued', 'running', 'stopping'].includes(row.status)) return row.status;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('실행이 끝나지 않음');
}
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => { vi.unstubAllGlobals(); });

describe('지도에서 연 보고서', { timeout: 15000 }, () => {
  it('채팅 요청 없이 대화에 저장하고, 같은 보고서는 다시 저장하지 않는다', async () => {
    const c = await repository().createConversation();
    const r = await app.request(`/api/conversations/${c.id}/reports`, json({ country: '폴란드', system: '다연장로켓' }));
    expect(r.status).toBe(201);
    const entry = await r.json() as any;
    expect(entry).toMatchObject({ country: 'POL', system: 'mrl', kind: 'country-analysis', viewed: true });
    expect(entry.markdown).toContain('폴란드');
    const again = await (await app.request(`/api/conversations/${c.id}/reports`, json({ country: 'POL', system: 'mrl' }))).json() as any;
    expect(again.id).toBe(entry.id);
    const saved = await (await app.request(`/api/conversations/${c.id}`)).json() as any;
    expect(saved.messages).toEqual([]);
    expect(saved.runs).toEqual([]);
    expect(saved.reportEntries.map((e: any) => [e.id, e.viewed])).toEqual([[entry.id, true]]);
    expect(saved.files.some((f: any) => f.name === `reports/${entry.id}.md` && f.kind === 'report')).toBe(true);
    expect((await app.request(`/api/conversations/${c.id}/reports`, json({ country: '없는국가' }))).status).toBe(400);
  });

  it('다음 메시지에 첨부하면 모델이 보고서 본문과 열린 보고서, 화면 상태를 받는다', async () => {
    const repo = repository(), c = await repo.createConversation();
    const entry = await (await app.request(`/api/conversations/${c.id}/reports`, json({ country: '폴란드', system: '다연장로켓' }))).json() as any;
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '답' }] }] }), { status: 200 });
    }));
    const report = { id: entry.id, country: 'POL', system: 'mrl', kind: 'country-analysis', basisDate: entry.basisDate, dataVersion: entry.dataVersion };
    const appContext = { screenId: randomUUID(), conversationId: c.id, model: 'gpt', activeView: 'report', mode: 'mrl', flat: true, focus: 'POL', filters: { system: 'mrl' }, report, dataVersion: entry.dataVersion };
    const text = '이 보고서 요약해 줘\n\n첨부: 폴란드 다연장로켓 보고서';
    const r = await app.request('/api/chat', json({ conversationId: c.id, model: 'gpt', messages: [{ role: 'user', text }], state: { mode: 'mrl', flat: true, focus: 'POL' }, appContext, reportIds: [entry.id] }), { OPENAI_API_KEY: 'test-key' });
    expect(r.status).toBe(202);
    expect(await waitDone((await r.json() as any).runId)).toBe('completed');
    const sent = JSON.stringify(bodies.at(-1));
    expect(sent).toContain(`[첨부 보고서 ${entry.id}`);
    expect(sent).toContain(JSON.stringify(entry.markdown.slice(0, 40)).slice(1, -1));
    // 화면 상태: 체계, 국가, 2D/3D, 열린 보고서를 요청마다 받는다
    const instructions = bodies.at(-1).instructions as string;
    expect(instructions).toContain('"mode":"mrl"'); expect(instructions).toContain('"focus":"POL"'); expect(instructions).toContain('"flat":true');
    expect(instructions).toContain(`"report":{"id":"${entry.id}"`);
    expect(instructions).toContain(`reports/${entry.id}.md`);
    expect(instructions).toContain('지도=2D');
    // 화면의 사용자 메시지는 짧은 첨부 이름만, 첨부 ID는 메시지 기록에 남는다
    const saved = (await repo.conversation(c.id)).messages.find((m: any) => m.role === 'user');
    expect(saved.text).toBe(text); expect(saved.reportIds).toEqual([entry.id]);
  });

  it('다른 대화의 보고서는 첨부할 수 없다', async () => {
    const repo = repository(), a = await repo.createConversation(), b = await repo.createConversation();
    const entry = await (await app.request(`/api/conversations/${a.id}/reports`, json({ country: 'POL' }))).json() as any;
    await expect(attachedReports(repo, b.id, [entry.id])).rejects.toThrow('찾을 수 없습니다');
    await expect(attachedReports(repo, a.id, 'x')).rejects.toThrow();
    expect((await attachedReports(repo, a.id, [entry.id, entry.id])).length).toBe(1);
  });
});
