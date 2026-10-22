import { describe, expect, it } from 'vitest';
import { completeSlash, modelStep, parseSlash, readChoice, slashSuggestions } from '../src/slash';
import { checkChoice, choiceLabel, CLI_OPTIONS, LABEL_SEP } from '../shared/model-options';
import { parseModelChoice } from '../server/model-choice';
import { appContextSchema } from '../server/app-context';
import { app } from '../server/app';
import { codexArgs, grokArgs } from '../server/cli';

describe('/ 명령 해석', () => {
  it('/sessions·/models와 별칭만 명령으로 본다', () => {
    expect(parseSlash('/sessions')).toEqual({ cmd: 'sessions' });
    expect(parseSlash('  /Sessions  ')).toEqual({ cmd: 'sessions' });
    expect(parseSlash('/models')).toEqual({ cmd: 'models' });
    expect(parseSlash('/모델')).toEqual({ cmd: 'models' });
    expect(parseSlash('/models gpt')).toBeNull();
    expect(parseSlash('/tmp/파일 경로를 봐줘')).toBeNull();
    expect(parseSlash('sessions')).toBeNull();
    expect(parseSlash('!모델 지피티')).toBeNull();
  });
});

describe('/ 명령 자동완성', () => {
  const names = (t: string) => slashSuggestions(t).map(s => s.command);
  it('/ 로 시작하는 부분 일치만 후보로 낸다', () => {
    expect(names('/')).toEqual(['/models', '/sessions']);
    expect(names('/m')).toEqual(['/models']);
    expect(names('/S')).toEqual(['/sessions']);
    expect(names('/세')).toEqual(['/sessions']);
    expect(names('／mo')).toEqual(['/models']);
    expect(names('/models')).toEqual(['/models']);
    expect(names('/x')).toEqual([]);
    expect(names('/models gpt')).toEqual([]);
    expect(names(' /m')).toEqual([]);
    expect(names('m')).toEqual([]);
    expect(names('/help')).toEqual([]);
    expect(slashSuggestions('/m')[0]).toMatchObject({ desc: '모델 변경' });
    expect(slashSuggestions('/s')[0]).toMatchObject({ desc: '세션 교체' });
  });
  it('Tab은 강조된 후보(기본 첫 후보)로 완성하고, 완성된 명령은 그대로 실행된다', () => {
    expect(completeSlash('/')).toBe('/models');
    expect(completeSlash('/', 1)).toBe('/sessions');
    expect(completeSlash('/', 9)).toBe('/sessions');
    expect(completeSlash('/se')).toBe('/sessions');
    expect(completeSlash('/zz')).toBe('/zz');
    expect(parseSlash(completeSlash('/mo'))).toEqual({ cmd: 'models' });
  });
});

describe('모델 선택 단계', () => {
  const current = { provider: 'codex' as const };
  it('제공자 → 코덱스 모델 → 추론 강도 → 완료', () => {
    const providers = modelStep([], current, new Set(['codex', 'gpt']));
    if ('done' in providers) throw new Error('단계');
    expect(providers.items.map(i => i.label)).toEqual(['그록 빌드', '코덱스', '지피티', '네모트론']);
    expect(providers.items.find(i => i.id === 'grok')!.disabled).toBe(true);
    const codex = modelStep(['codex'], current);
    if ('done' in codex) throw new Error('단계');
    expect(codex.items.map(i => i.id)).toEqual(['gpt-6.1-sol', 'gpt-6.1-luna', 'gpt-6-astra']);
    expect(codex.items[0]).toMatchObject({ current: true, hint: '기본' });
    const efforts = modelStep(['codex', 'gpt-6.1-sol'], current);
    if ('done' in efforts) throw new Error('단계');
    expect(efforts.items.map(i => i.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(efforts.items.find(i => i.current)!.id).toBe('xhigh');
    expect(modelStep(['codex', 'gpt-6.1-sol', 'high'], current)).toEqual({ done: { provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
  });
  it('그록 빌드는 확인한 모델과 low~xhigh, 지피티·네모트론은 바로 완료', () => {
    const grok = modelStep(['grok'], current);
    if ('done' in grok) throw new Error('단계');
    expect(grok.items.map(i => i.id)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5']);
    const efforts = modelStep(['grok', 'grok-4.7'], current);
    if ('done' in efforts) throw new Error('단계');
    expect(efforts.items.map(i => i.id)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(modelStep(['gpt'], current)).toEqual({ done: { provider: 'gpt' } });
    expect(modelStep(['nemotron'], current)).toEqual({ done: { provider: 'nemotron' } });
  });
  it('저장 형식과 표시', () => {
    expect(readChoice('gpt')).toEqual({ provider: 'gpt' });
    expect(readChoice('gemma')).toBeNull();
    expect(readChoice(JSON.stringify({ provider: 'grok', model: 'grok-4.6', effort: 'low' }))).toEqual({ provider: 'grok', model: 'grok-4.6', effort: 'low' });
    expect(readChoice(JSON.stringify({ provider: 'grok', model: 'grok-9' }))).toBeNull();
    expect(choiceLabel({ provider: 'codex' })).toBe('코덱스 | gpt-6.1-sol | xhigh');
    expect(choiceLabel({ provider: 'nemotron' })).toBe('네모트론');
    expect(choiceLabel({ provider: 'grok', model: 'grok-4.6', effort: 'low' })).toBe('그록 빌드 | grok-4.6 | low');
    expect(LABEL_SEP).toBe(' | ');
    expect(CLI_OPTIONS.codex.defaultEffort).toBe('xhigh');
  });
});

describe('서버 측 모델 선택 검증', () => {
  it('허용 값만 통과한다', () => {
    expect(parseModelChoice('codex', { model: 'gpt-6-astra', effort: 'ultra' })).toEqual({ provider: 'codex', model: 'gpt-6-astra', effort: 'ultra' });
    expect(parseModelChoice('grok', undefined)).toEqual({ provider: 'grok' });
    expect(parseModelChoice(undefined, undefined)).toBeUndefined();
    expect(() => parseModelChoice('codex', { model: 'gpt-6.1-luna', effort: 'ultra' })).toThrow(/추론 강도/);
    expect(() => parseModelChoice('grok', { effort: 'max' })).toThrow(/추론 강도/);
    expect(() => parseModelChoice('grok', { model: 'grok-9' })).toThrow(/허용하지 않는 모델/);
    expect(() => parseModelChoice('gpt', { model: 'gpt-6.1-sol' })).toThrow(/세부 모델/);
    expect(() => parseModelChoice('codex', { model: 'gpt-6.1-sol', extra: 1 })).toThrow(/모델 선택 오류/);
    expect(checkChoice({ provider: 'gemma' }).ok).toBe(false);
  });
  it('/api/chat은 잘못된 선택을 400으로 거절한다', async () => {
    const r = await app.request('/api/chat', { method: 'POST', body: JSON.stringify({ model: 'codex', options: { effort: 'turbo' }, messages: [{ role: 'user', text: 'hi' }] }), headers: { 'content-type': 'application/json' } }, { LOCAL_CLI: '0' });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain('추론 강도');
  });
  it('화면 맥락은 modelOptions를 허용하고 모르는 키를 거절한다', () => {
    const base = { screenId: crypto.randomUUID(), version: 1, conversationId: null, model: 'codex', activeView: 'map', mode: null, flat: false, focus: null, filters: { system: null }, report: null, dataVersion: 1 };
    expect(appContextSchema.safeParse({ ...base, modelOptions: { model: 'gpt-6-astra', effort: 'high' } }).success).toBe(true);
    expect(appContextSchema.safeParse({ ...base, modelOptions: { foo: 1 } }).success).toBe(false);
  });
  it('선택한 CLI 모델·강도가 실행 인자로 간다', () => {
    const g = grokArgs({ promptFile: 'p', sid: 's', cwd: '/w', model: 'grok-4.6', effort: 'low' });
    expect(g.slice(g.indexOf('-m'), g.indexOf('-m') + 4)).toEqual(['-m', 'grok-4.6', '--reasoning-effort', 'low']);
    const c = codexArgs({ cwd: '/w', node: 'node', tsx: 't', mcp: 'm', model: 'gpt-6-astra', effort: 'max' });
    expect(c).toContain('gpt-6-astra'); expect(c).toContain('model_reasoning_effort="max"');
  });
});
