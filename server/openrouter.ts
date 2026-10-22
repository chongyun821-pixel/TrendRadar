/** 네모트론 슈퍼를 먼저 호출하고 실패하면 OpenRouter 무료 모델 라우터를 사용한다. */
import { openaiTools, systemPrompt, recentMessages, runTool, newOut, parseActionBlock, PAGE_TOOLS, TOOL_DEFS, type ChatIn, type ChatOut } from './agent';
import type { Env } from './env';
import { executions } from './execution';
import { imageAttachments } from './attachments';
import { contextMessages, SUMMARY_PROMPT } from './context';
import { ReqError, sleep } from './http';

export const NEMOTRON_SUPER = 'nvidia/nemotron-3-super-120b-a12b:free';
export const FREE_MODELS_ROUTER = 'openrouter/free';

const TEXT_PROTOCOL = [
  '도구는 함수 호출 대신 답 맨 끝의 JSON 블록으로 요청한다:',
  '```json',
  '{"tools":[{"name":"get_forecast","args":{"country":"폴란드","system":"자주포"}},{"name":"focus_country","args":{"country":"폴란드"}}]}',
  '```',
  '조회 도구 결과는 다음 메시지로 전달된다. 결과를 받은 뒤에는 블록 없이 답하거나 화면 도구만 블록으로 보낸다.',
  '도구: ' + TOOL_DEFS.map(t => `${t.name}(${Object.keys(t.properties).join(',')}) ${t.description}`).join('; '),
].join('\n');

const toolUnsupported = (e: unknown) => e instanceof ReqError && (e.status === 400 || e.status === 404) && /no endpoints.{0,80}support.{0,40}(?:tool|function)|(?:tool|function).{0,80}(?:not supported|unsupported)|(?:does not|doesn't|do not|don't) support.{0,40}(?:tool|function)/i.test(e.body);

export async function chatOpenRouter(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut();
  const key = env.OPENROUTER_API_KEY?.trim();
  let model = NEMOTRON_SUPER;
  let textMode = false;
  out.model = model;
  if (!key) return { ...out, nokey: true, reply: 'OpenRouter 키 없음' };
  const url = `${(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`;
  async function call(messages: any[], system: string, withTools = false): Promise<any> {
    for (;;) {
      const text = withTools && textMode;
      input.signal?.throwIfAborted();
      const body: any = { model, temperature: 0.3, messages: [{ role: 'system', content: text ? `${system}\n${TEXT_PROTOCOL}` : system }, ...messages] };
      if (withTools && !text) { body.tools = openaiTools(); body.tool_choice = 'auto'; }
      try {
        const ctx = executions.getStore();
        await ctx?.repo.event(ctx.runId, 'model.request', { model });
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-title': 'procurement-radar' }, body: JSON.stringify(body), signal: input.signal });
        const t = await r.text();
        if (!r.ok) throw new ReqError(r.status, t.slice(0, 400));
        const j = JSON.parse(t);
        if (j?.error) throw new ReqError(Number(j.error.code) || 502, JSON.stringify(j.error).slice(0, 400));
        if (!j?.choices?.[0]?.message) throw new ReqError(502, 'empty');
        // 실제 모델 이름은 표시용이다. 다음 요청도 무료 라우터를 유지해 유료 별칭으로 바뀌지 않게 한다.
        out.model = typeof j.model === 'string' && j.model.trim() ? j.model : model;
        return { msg: j.choices[0].message, text };
      } catch (e) {
        input.signal?.throwIfAborted();
        if (e instanceof ReqError && e.status === 401) throw e;
        if (withTools && !text && toolUnsupported(e)) { textMode = true; continue; }
        if (model === NEMOTRON_SUPER) {
          const ctx = executions.getStore();
          await ctx?.repo.event(ctx.runId, 'model.fallback', { from: model, to: FREE_MODELS_ROUTER, status: e instanceof ReqError ? e.status : null });
          model = FREE_MODELS_ROUTER;
          out.model = model;
          textMode = false;
          continue;
        }
        throw e;
      }
    }
  }

  try {
    const history = await contextMessages(input, async prompt => String((await call([{ role: 'user', content: prompt }], SUMMARY_PROMPT)).msg.content || ''));
    const hist = recentMessages({ ...input, messages: history });
    if (!hist.length || hist[hist.length - 1].role !== 'user') return { ...out, error: '메시지 없음' };
    const sys = systemPrompt(input.state, 'nemotron');
    const msgs: any[] = hist.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }));
    if (executions.getStore()) {
      const images = await imageAttachments();
      if (images.length) msgs.at(-1).content = [{ type: 'text', text: msgs.at(-1).content }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }))];
    }
    for (;;) {
      input.signal?.throwIfAborted();
      const { msg, text } = await call(msgs, sys, true);
      if (!text) {
        const calls: any[] = msg.tool_calls ?? [];
        if (!calls.length) { out.reply = String(msg.content ?? '').trim() || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
        msgs.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
        for (const c of calls) {
          const name = c.function?.name ?? '';
          let args: any = {};
          try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; }
          out.tools.push(name);
          msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(await runTool(name, args, out)) });
        }
      } else {
        const p = parseActionBlock(String(msg.content ?? ''));
        const data: string[] = [];
        for (const c of p.calls) { out.tools.push(c.name); const res = await runTool(c.name, c.args, out); if (!PAGE_TOOLS.has(c.name)) data.push(`${c.name}: ${JSON.stringify(res)}`); }
        if (!data.length) { out.reply = p.text || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
        msgs.push({ role: 'assistant', content: String(msg.content ?? '') }, { role: 'user', content: `도구 결과:\n${data.join('\n')}` });
      }
    }
  } catch (e) {
    input.signal?.throwIfAborted();
    const st = e instanceof ReqError ? e.status : 0;
    const msg = st === 401 ? 'OpenRouter 키 오류' : st === 429 ? '요청 한도 초과. 잠시 후 다시 시도' : st === 402 ? 'OpenRouter 크레딧 부족' : st ? `AI 오류 ${st}` : 'OpenRouter 연결 실패';
    return { ...out, error: msg, detail: e instanceof ReqError ? e.body.slice(0, 300) : String(e).slice(0, 200) };
  }
}
