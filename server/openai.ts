/** 지피티: OpenAI Responses API(함수 호출)와 공용 도구 정의를 사용한다. */
import { responsesTools, systemPrompt, recentMessages, runTool, newOut, type ChatIn, type ChatOut } from './agent';
import type { Env } from './env';
import { executions } from './execution';
import { imageAttachments } from './attachments';
import { contextMessages, SUMMARY_PROMPT } from './context';
import { ReqError, sleep } from './http';

export const GPT_MODEL = 'gpt-5.4-mini';

/** 응답의 output 배열에서 최종 문장을 모은다 */
export const outputText = (output: any[]) => output.filter(i => i?.type === 'message').flatMap(i => i.content || []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text || '').join('').trim();

export async function chatOpenAI(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut();
  const key = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim() || GPT_MODEL;
  out.model = model;
  if (!key) return { ...out, nokey: true, reply: 'OpenAI 키 없음' };
  const url = `${(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
  async function post(body: unknown): Promise<any> {
    let last: ReqError | undefined;
    for (let i = 0; i < 3; i++) { // 최초 1회 + 5xx 재시도 2회
      input.signal?.throwIfAborted();
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: input.signal });
      const t = await r.text();
      if (r.ok) { const j = JSON.parse(t); if (j?.error) throw new ReqError(502, JSON.stringify(j.error).slice(0, 400)); return j; }
      last = new ReqError(r.status, t.slice(0, 400));
      if (r.status < 500) throw last;
      await sleep(700 * (i + 1), input.signal);
    }
    throw last!;
  }
  try {
    const history = await contextMessages(input, async prompt => outputText((await post({ model, store: false, instructions: SUMMARY_PROMPT, input: prompt })).output || []));
    const hist = recentMessages({ ...input, messages: history });
    if (!hist.length || hist[hist.length - 1].role !== 'user') return { ...out, error: '메시지 없음' };
    const items: any[] = hist.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }));
    if (executions.getStore()) {
      const images = await imageAttachments();
      if (images.length) items.at(-1).content = [{ type: 'input_text', text: items.at(-1).content }, ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mime};base64,${image.base64}` }))];
    }
    const instructions = systemPrompt(input.state, 'gpt');
    const tools = responsesTools();
    for (;;) {
      input.signal?.throwIfAborted();
      const ctx = executions.getStore();
      await ctx?.repo.event(ctx.runId, 'model.request', { model });
      // store=false: 서버에 대화를 남기지 않고, 추론 항목은 암호화본을 받아 다음 요청에 되돌려준다
      const j = await post({ model, store: false, include: ['reasoning.encrypted_content'], instructions, input: items, tools, tool_choice: 'auto', parallel_tool_calls: true });
      const output: any[] = j.output || [];
      const calls = output.filter(i => i?.type === 'function_call');
      if (!calls.length) { out.reply = outputText(output) || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
      items.push(...output.filter(i => i?.type === 'reasoning' || i?.type === 'function_call' || i?.type === 'message'));
      for (const c of calls) {
        let args: any = {};
        try { args = JSON.parse(c.arguments || '{}'); } catch { args = {}; }
        out.tools.push(c.name);
        items.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(await runTool(c.name, args, out) ?? null) });
      }
    }
  } catch (e) {
    input.signal?.throwIfAborted();
    const st = e instanceof ReqError ? e.status : 0;
    const body = e instanceof ReqError ? e.body : '';
    const msg = st === 401 ? 'OpenAI 키 오류' : st === 429 ? (/insufficient_quota/.test(body) ? 'OpenAI 사용 한도·결제 확인 필요' : '요청 한도 초과. 잠시 후 다시 시도') : st === 404 ? '모델을 찾을 수 없음' : st === 403 ? 'OpenAI 접근 권한 오류' : st ? `AI 오류 ${st}` : 'OpenAI 연결 실패';
    return { ...out, error: msg, detail: body ? body.slice(0, 300) : String(e).slice(0, 200) };
  }
}
