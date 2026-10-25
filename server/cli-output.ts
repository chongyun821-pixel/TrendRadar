/** CLI 출력(JSONL) 해석: 그록 빌드 streaming-json · 코덱스 exec --json. 순수 함수 */

export const isAuthError = (s: string) => /not (logged|signed) in|log ?in required|please (log|sign) ?in|grok login|codex login|unauthori[sz]ed|\b401\b|authenticat|credential|refresh token|token (has )?expired/i.test(s);

export interface CliParsed { text: string; tools: string[]; error?: string; auth?: boolean; usage?: { input: number; cached: number; output: number } }

/** grok --output-format streaming-json: 마지막 도구 호출 뒤의 text 가 최종 답 */
export function parseGrokStream(stdout: string, stderr = ''): CliParsed {
  let all = '', tail = '', error: string | undefined, usage: CliParsed['usage'];
  const tools: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim(); if (!l.startsWith('{')) continue;
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'text' && typeof e.data === 'string') { all += e.data; tail += e.data; }
    else if (e.type === 'tool_call') {
      tail = '';
      const ri = e.rawInput ?? {};
      const n = String(ri.name ?? ri.tool_name ?? ri.tool ?? e.toolName ?? '');
      if (n && !/^search_tool$/.test(n)) tools.push(n.replace(/^procurement__/, ''));
    } else if (e.type === 'error') error = String(e.message ?? 'error');
    else if (e.type === 'end') {
      if (e.usage) usage = { input: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0), cached: e.usage.cache_read_input_tokens ?? 0, output: e.usage.output_tokens ?? 0 };
      if (e.stopReason === 'cancelled' || e.stopReason === 'error') error = `그록 실행 ${e.stopReason}: 도구 권한과 연결 상태를 확인하세요`;
    }
    else if (typeof e.text === 'string' && !all) { all = e.text; tail = e.text; } // --output-format json 호환
  }
  const text = (tail.trim() || all.trim());
  const errText = `${error ?? ''}\n${text ? '' : stderr}`;
  return { text, usage, tools: tools.filter(t => t !== 'use_tool'), error: error ?? (!text && stderr.trim() ? stderr.trim().slice(-300) : undefined), auth: isAuthError(errText) };
}

/** codex exec --json: 마지막 agent_message 가 최종 답 */
export function parseCodexJsonl(stdout: string, stderr = ''): CliParsed {
  let text = '', error: string | undefined, usage: CliParsed['usage'];
  const tools: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim(); if (!l.startsWith('{')) continue;
    let e: any; try { e = JSON.parse(l); } catch { continue; }
    const it = e.item;
    if (e.type === 'item.completed' && it?.type === 'agent_message' && typeof it.text === 'string') text = it.text;
    else if (e.type === 'item.completed' && it?.type === 'mcp_tool_call') tools.push(String(it.tool ?? ''));
    else if (e.type === 'item.completed' && it?.type === 'web_search') tools.push(it.action?.type === 'open_page' ? 'web_open' : 'web_search');
    else if (e.type === 'error') error = String(e.message ?? 'error');
    else if (e.type === 'turn.failed') error = String(e.error?.message ?? 'turn failed');
    else if (e.type === 'turn.completed' && e.usage) usage = { input: e.usage.input_tokens ?? 0, cached: e.usage.cached_input_tokens ?? 0, output: e.usage.output_tokens ?? 0 };
  }
  const errText = `${error ?? ''}\n${text ? '' : stderr}`;
  return { text: text.trim(), usage, tools, error: error ?? (!text && stderr.trim() ? stderr.trim().slice(-300) : undefined), auth: isAuthError(errText) };
}
