/** 네모트론: OpenRouter(OpenAI 호환) + 같은 도구 정의. Ultra(무료) 실패 시 Super(무료)로 전환 */
import { openaiTools, systemPrompt, recentMessages, runTool, trim, newOut, parseActionBlock, PAGE_TOOLS, TOOL_DEFS, type ChatIn, type ChatOut } from './agent';
import type { Env } from './gemma';

export const NEMOTRON_ULTRA = 'nvidia/nemotron-3-ultra-550b-a55b:free';
export const NEMOTRON_SUPER = 'nvidia/nemotron-3-super-120b-a12b:free';

const TEXT_PROTOCOL = [
  '도구는 함수 호출 대신 답 맨 끝의 JSON 블록으로 요청한다:',
  '```json',
  '{"tools":[{"name":"get_forecast","args":{"country":"폴란드","system":"자주포"}},{"name":"focus_country","args":{"country":"폴란드"}}]}',
  '```',
  '조회 도구 결과는 다음 메시지로 전달된다. 결과를 받은 뒤에는 블록 없이 답하거나 화면 도구만 블록으로 보낸다.',
  '도구: ' + TOOL_DEFS.map(t => `${t.name}(${Object.keys(t.properties).join(',')}) ${t.description}`).join('; '),
].join('\n');

class ReqError extends Error { constructor(public status: number, public body: string) { super(`HTTP ${status}`); } }
/** 다음 모델로 넘어갈 실패: 한도·결제·없음·타임아웃·5xx·네트워크 */
export const shouldFallback = (e: unknown) => !(e instanceof ReqError) || [402, 404, 408, 409, 429].includes(e.status) || e.status >= 500;
const toolUnsupported = (e: unknown) => e instanceof ReqError && (e.status === 400 || e.status === 404) && /tool|function/i.test(e.body);

export async function chatOpenRouter(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut();
  const key = env.OPENROUTER_API_KEY?.trim();
  const models = [env.OPENROUTER_MODEL || NEMOTRON_ULTRA, env.OPENROUTER_FALLBACK_MODEL || NEMOTRON_SUPER].filter((m, i, a) => m && a.indexOf(m) === i);
  out.model = models[0];
  if (!key) return { ...out, nokey: true, reply: 'OpenRouter 키 없음' };
  const url = `${(env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '')}/chat/completions`;
  const hist = recentMessages(input);
  if (!hist.length || hist[hist.length - 1].role !== 'user') return { ...out, error: '메시지 없음' };
  const sys = systemPrompt(input.state);
  const msgs: any[] = hist.map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.text }));
  let mi = 0;
  const textMode = new Set<string>(); // 도구 미지원으로 확인된 모델

  async function call(withTools: boolean): Promise<any> {
    for (;;) {
      const model = models[mi];
      const text = textMode.has(model);
      const body: any = { model, temperature: 0.3, max_tokens: 1500, messages: [{ role: 'system', content: text ? `${sys}\n${TEXT_PROTOCOL}` : sys }, ...msgs] };
      if (withTools && !text) { body.tools = openaiTools(); body.tool_choice = 'auto'; }
      try {
        const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'x-title': 'procurement-radar' }, body: JSON.stringify(body) };
        try { (init as any).signal = AbortSignal.timeout(90000); } catch { /* 구형 런타임 */ }
        const r = await fetch(url, init);
        const t = await r.text();
        if (!r.ok) throw new ReqError(r.status, t.slice(0, 400));
        const j = JSON.parse(t);
        if (j?.error) throw new ReqError(Number(j.error.code) || 502, JSON.stringify(j.error).slice(0, 400));
        if (!j?.choices?.[0]?.message) throw new ReqError(502, 'empty');
        out.model = model;
        return { msg: j.choices[0].message, text };
      } catch (e) {
        if (e instanceof ReqError && e.status === 401) throw e;
        if (withTools && !text && toolUnsupported(e)) { textMode.add(model); continue; }
        if (shouldFallback(e) && mi < models.length - 1) { mi++; continue; }
        throw e;
      }
    }
  }

  try {
    for (let round = 0; round <= 3; round++) {
      const withTools = round < 3;
      const { msg, text } = await call(withTools);
      if (!text) {
        const calls: any[] = msg.tool_calls ?? [];
        if (!calls.length || !withTools) { out.reply = String(msg.content ?? '').trim() || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
        msgs.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
        for (const c of calls) {
          const name = c.function?.name ?? '';
          let args: any = {};
          try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; }
          out.tools.push(name);
          msgs.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(trim(runTool(name, args, out))) });
        }
      } else {
        const p = parseActionBlock(String(msg.content ?? ''));
        const data: string[] = [];
        for (const c of p.calls) { out.tools.push(c.name); const res = runTool(c.name, c.args, out); if (!PAGE_TOOLS.has(c.name)) data.push(`${c.name}: ${JSON.stringify(trim(res, 2500))}`); }
        if (!data.length || !withTools) { out.reply = p.text || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
        msgs.push({ role: 'assistant', content: String(msg.content ?? '') }, { role: 'user', content: `도구 결과:\n${data.join('\n')}` });
      }
    }
    out.reply = out.reply || '완료';
    return out;
  } catch (e) {
    const st = e instanceof ReqError ? e.status : 0;
    const msg = st === 401 ? 'OpenRouter 키 오류' : st === 429 ? '요청 한도 초과. 잠시 후 다시 시도' : st === 402 ? 'OpenRouter 크레딧 부족' : st ? `AI 오류 ${st}` : 'OpenRouter 연결 실패';
    return { ...out, error: msg, detail: e instanceof ReqError ? e.body.slice(0, 300) : String(e).slice(0, 200) };
  }
}
