import { describe, it, expect, vi, afterEach } from 'vitest';
import { chat } from '../server/gemma';
import { app } from '../server/app';

afterEach(() => vi.unstubAllGlobals());
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('chat (Gemma generateContent)', () => {
  it('키가 없으면 nokey', async () => {
    const r = await chat({ messages: [{ role: 'user', text: '안녕' }] }, {});
    expect(r.nokey).toBe(true);
  });
  it('도구 호출 → 화면 동작·보고서 → 최종 답 (헤더·모델·5xx 재시도)', async () => {
    const calls: any[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      n++;
      if (n === 1) return new Response('busy', { status: 503 });
      if (n === 2) return ok({ candidates: [{ content: { role: 'model', parts: [
        { functionCall: { name: 'set_mode', args: { system: '자주포' } } },
        { functionCall: { name: 'write_report', args: { country: '폴란드', system: '자주포' } } }] } }] });
      return ok({ candidates: [{ content: { role: 'model', parts: [{ text: '폴란드 자주포 보고서를 띄웠습니다.' }] } }] });
    }));
    const r = await chat({ messages: [{ role: 'user', text: '폴란드 자주포 보고서' }] }, { GOOGLE_API_KEY: 'k' });
    expect(calls[0].url).toContain('/models/gemma-4-26b-a4b-it:generateContent');
    expect(calls[0].headers['x-goog-api-key']).toBe('k');
    expect(calls[1].body.tools[0].functionDeclarations.map((f: any) => f.name)).toContain('write_report');
    expect(r.actions).toContainEqual({ type: 'set_mode', system: 'sph' });
    expect(r.actions).toContainEqual({ type: 'focus_country', country: 'POL' });
    expect(r.reports[0]).toContain('폴란드');
    expect(r.reply).toContain('보고서');
    expect(calls[2].body.contents.at(-1).parts[0].functionResponse.name).toBe('set_mode');
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
