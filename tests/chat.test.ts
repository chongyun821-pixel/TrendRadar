import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatOpenAI, GPT_MODEL } from '../server/openai';
import { app } from '../server/app';

afterEach(() => vi.unstubAllGlobals());
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (text: string) => ({ messages: [{ role: 'user' as const, text }] });

describe('chat (지피티, OpenAI Responses)', () => {
  it('키가 없으면 nokey', async () => {
    const r = await chatOpenAI(user('안녕'), {});
    expect(r.nokey).toBe(true); expect(r.reply).toBe('OpenAI 키 없음');
  });
  it('잘못된 키와 사용 한도를 구분', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: { message: 'Incorrect API key provided' } }, 401)));
    expect((await chatOpenAI(user('안녕'), { OPENAI_API_KEY: 'fake' })).error).toBe('OpenAI 키 오류');
    vi.stubGlobal('fetch', vi.fn(async () => ok({ error: { code: 'insufficient_quota' } }, 429)));
    expect((await chatOpenAI(user('안녕'), { OPENAI_API_KEY: 'fake' })).error).toBe('OpenAI 사용 한도·결제 확인 필요');
  });
  it('도구 호출 → 화면 동작·보고서 → 최종 답 (헤더·모델·추론 항목 반환·5xx 재시도)', async () => {
    const calls: any[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      n++;
      if (n === 1) return new Response('busy', { status: 503 });
      if (n === 2) return ok({ output: [
        { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'set_mode', arguments: '{"system":"자주포"}' },
        { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'write_report', arguments: '{"country":"폴란드","system":"자주포"}' }] });
      return ok({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '폴란드 자주포 보고서를 띄웠습니다.' }] }] });
    }));
    const r = await chatOpenAI(user('폴란드 자주포 보고서'), { OPENAI_API_KEY: 'k' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0].headers.authorization).toBe('Bearer k');
    expect(calls[1].body.model).toBe(GPT_MODEL);
    expect(calls[1].body.store).toBe(false);
    expect(calls[1].body.include).toEqual(['reasoning.encrypted_content']);
    expect(calls[1].body.tools.find((t: any) => t.name === 'write_report')).toMatchObject({ type: 'function', parameters: { type: 'object' } });
    expect(typeof calls[1].body.instructions).toBe('string');
    expect(r.actions).toContainEqual({ type: 'set_mode', system: 'sph' });
    expect(r.actions).toContainEqual({ type: 'focus_country', country: 'POL' });
    expect(r.reports[0]).toContain('폴란드');
    expect(r.reply).toContain('보고서');
    const sent = calls[2].body.input;
    expect(sent.map((i: any) => i.type || i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
    expect(sent.filter((i: any) => i.type === 'function_call_output').map((i: any) => i.call_id)).toEqual(['call_1', 'call_2']);
    expect(r.tools).toEqual(['set_mode', 'write_report']);
  });
  it('OPENAI_MODEL로 모델을 바꾼다', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return ok({ output: [{ type: 'message', content: [{ type: 'output_text', text: '네' }] }] }); }));
    const r = await chatOpenAI(user('안녕'), { OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-5.4' });
    expect(bodies[0].model).toBe('gpt-5.4'); expect(r.reply).toBe('네'); expect(r.model).toBe('gpt-5.4');
  });
});

describe('API', () => {
  it('GET /api/forecasts', async () => {
    const r = await app.request('/api/forecasts?system=호위함');
    const j = await r.json(); expect(Array.isArray(j)).toBe(true); expect(j.length).toBeGreaterThan(3);
  });
  it('POST /api/chat without key', async () => {
    const r = await app.request('/api/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', text: 'hi' }] }), headers: { 'content-type': 'application/json' } }, {});
    expect((await r.json()).nokey).toBe(true);
  });
});
