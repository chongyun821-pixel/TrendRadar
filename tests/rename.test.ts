import { describe, expect, it } from 'vitest';
import { repository } from '../server/store';
import { app } from '../server/app';

const patch = (id: string, body: unknown) => app.request(`/api/conversations/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('대화 제목 변경 API', () => {
  it('제목을 바꾸고 목록, 대화 조회에 반영하며 순서(updated_at)는 유지한다', async () => {
    const repo = repository(), c = await repo.createConversation();
    const before = (await repo.one('SELECT updated_at FROM conversations WHERE id=?', c.id)).updated_at;
    const r = await patch(c.id, { title: '  폴란드   자주포 조사 ' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: c.id, title: '폴란드 자주포 조사' });
    expect((await (await app.request(`/api/conversations/${c.id}`)).json()).title).toBe('폴란드 자주포 조사');
    const rows = await (await app.request('/api/conversations')).json();
    expect(rows.find((x: { id: string }) => x.id === c.id).title).toBe('폴란드 자주포 조사');
    expect((await repo.one('SELECT updated_at FROM conversations WHERE id=?', c.id)).updated_at).toBe(before);
    // 바꾼 제목은 첫 메시지 자동 제목으로 덮어쓰지 않는다
    await repo.message(c.id, 'user', '다른 질문');
    expect((await repo.conversation(c.id)).title).toBe('폴란드 자주포 조사');
  });
  it('빈 제목, 잘못된 본문은 400, 없는 대화는 404', async () => {
    const c = await repository().createConversation();
    expect((await patch(c.id, { title: '   ' })).status).toBe(400);
    expect((await patch(c.id, { title: 'x', extra: 1 })).status).toBe(400);
    expect((await patch(c.id, { title: 'x'.repeat(121) })).status).toBe(400);
    expect((await app.request(`/api/conversations/${c.id}`, { method: 'PATCH', body: 'not json' })).status).toBe(400);
    const missing = await patch('00000000-0000-4000-8000-000000000000', { title: '없음' });
    expect(missing.status).toBe(404);
    await expect(repository().renameConversation(c.id, ' \n ')).rejects.toThrow('제목을 입력하세요');
  });
});
