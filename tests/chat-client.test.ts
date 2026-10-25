import { describe, it, expect } from 'vitest';
import { chatBody, pickModel, runStatusText, isActiveStatus } from '../src/chat-api';
import { choiceLabel } from '../shared/model-options';
import { app } from '../server/app';
import { cliChoice } from '../server/cli';

describe('채팅 요청 본문', () => {
  it('선택한 제공자와 CLI 모델, 추론 강도를 요청마다 그대로 보낸다', () => {
    expect(chatBody({ provider: 'grok', model: 'grok-4.6', effort: 'low' }, 'c1', '안녕', { mode: null }, { focus: 'POL' })).toEqual({
      conversationId: 'c1', model: 'grok', options: { model: 'grok-4.6', effort: 'low' }, messages: [{ role: 'user', text: '안녕' }], state: { mode: null }, appContext: { focus: 'POL' },
    });
    expect(chatBody({ provider: 'gpt' }, 'c1', 'x', {}, {})).not.toHaveProperty('options');
  });
  it('상태 문구와 진행 상태', () => {
    expect(runStatusText({ status: 'completed' })).toBe('완료');
    expect(runStatusText({ status: 'cancelled' })).toBe('작업 중지됨');
    expect(runStatusText({ status: 'cancelled', error: '사용자가 조사를 중지했습니다' })).toBe('사용자가 조사를 중지했습니다');
    expect(['queued', 'running', 'stopping', 'cancelled'].map(isActiveStatus)).toEqual([true, true, true, false]);
    expect(pickModel('그록 빌드', [])).toBe('grok');
  });
});

describe('모델 목록과 기본값 표시', () => {
  it('목록 순서는 그록 빌드, 코덱스, 지피티, 네모트론이고, 세부 선택이 없을 때 서버가 쓸 CLI 기본값을 알려준다', async () => {
    const env = { LOCAL_CLI: '0', GROK_EFFORT: 'medium', CODEX_MODEL: 'gpt-6-astra' };
    const body = await (await app.request('/api/models', {}, env)).json() as any;
    expect(body.models.map((m: { name: string }) => m.name)).toEqual(['그록 빌드', '코덱스', '지피티', '네모트론']);
    expect(body.defaults).toEqual({ grok: { model: 'grok-4.7', effort: 'medium' }, codex: { model: 'gpt-6-astra', effort: 'high' } });
    expect((await (await app.request('/api/models', {}, { LOCAL_CLI: '0' })).json() as any).defaults.codex).toEqual({ model: 'gpt-6-luna', effort: 'high' });
    expect(choiceLabel({ provider: 'grok' }, body.defaults.grok)).toBe('그록 빌드 | grok-4.7 | medium');
    expect(cliChoice('codex', env, { effort: 'low' })).toEqual({ model: 'gpt-6-astra', effort: 'low' });
  });
});
