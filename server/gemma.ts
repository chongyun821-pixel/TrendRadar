import { geminiDeclarations, systemPrompt, recentMessages, runTool, trim, newOut, type ChatIn, type ChatOut } from './agent';
export { runTool } from './agent';
export type { ChatIn, ChatOut } from './agent';

export interface Env {
  GOOGLE_API_KEY?: string; GEMMA_MODEL?: string; GOOGLE_BASE_URL?: string;
  OPENROUTER_API_KEY?: string; OPENROUTER_MODEL?: string; OPENROUTER_FALLBACK_MODEL?: string; OPENROUTER_BASE_URL?: string;
  GROK_BIN?: string; GROK_MODEL?: string; GROK_EFFORT?: string; CODEX_BIN?: string; CODEX_MODEL?: string; CODEX_EFFORT?: string; LOCAL_CLI?: string; CLI_RUNTIME_DIR?: string;
}

export const FUNCTION_DECLARATIONS = geminiDeclarations();

async function post(url: string, key: string, body: unknown): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i < 3; i++) { // 최초 1회 + 5xx 재시도 2회
    const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) };
    try { (init as any).signal = AbortSignal.timeout(60000); } catch { /* 구형 런타임 */ }
    last = await fetch(url, init);
    if (last.status < 500) return last;
    await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  return last!;
}

export async function chat(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut();
  const key = env.GOOGLE_API_KEY?.trim();
  const model = env.GEMMA_MODEL || 'gemma-4-26b-a4b-it';
  out.model = model;
  if (!key) return { ...out, nokey: true, reply: 'Google 키 없음' };
  const base = (env.GOOGLE_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const url = `${base}/models/${model}:generateContent`;
  const sys = systemPrompt(input.state);
  const contents: any[] = recentMessages(input).map(m => ({ role: m.role, parts: [{ text: m.text }] }));
  if (!contents.length || contents[contents.length - 1].role !== 'user') return { ...out, error: '메시지 없음' };
  let fold = false;

  const body = (withTools: boolean) => {
    const c = fold ? [{ role: 'user', parts: [{ text: sys }] }, { role: 'model', parts: [{ text: '알겠습니다.' }] }, ...contents] : contents;
    const b: any = { contents: c, generationConfig: { temperature: 0.3, maxOutputTokens: 1200 } };
    if (!fold) b.systemInstruction = { parts: [{ text: sys }] };
    if (withTools) { b.tools = [{ functionDeclarations: FUNCTION_DECLARATIONS }]; b.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; }
    return b;
  };

  for (let round = 0; round <= 3; round++) {
    const withTools = round < 3;
    let r = await post(url, key, body(withTools));
    if (r.status === 400 && !fold) { fold = true; r = await post(url, key, body(withTools)); }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      const msg = r.status === 429 ? '요청 한도 초과. 잠시 후 다시 시도' : r.status === 403 || r.status === 401 || /API key|API_KEY/i.test(t) ? 'API 키 오류' : r.status === 404 ? '모델을 찾을 수 없음' : `AI 오류 ${r.status}`;
      return { ...out, error: msg, detail: t.slice(0, 300) } as ChatOut;
    }
    const j: any = await r.json();
    const parts: any[] = j?.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter(p => p.functionCall);
    const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
    if (!calls.length) { out.reply = text || (out.reports.length ? '보고서를 표시했습니다.' : '…'); return out; }
    contents.push({ role: 'model', parts: parts.filter(p => !p.thought || p.thoughtSignature) });
    const responses: any[] = [];
    for (const p of calls) {
      const name: string = p.functionCall.name; const args = p.functionCall.args ?? {};
      out.tools.push(name);
      responses.push({ functionResponse: { name, response: { result: trim(runTool(name, args, out)) } } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  out.reply = out.reply || '완료';
  return out;
}
