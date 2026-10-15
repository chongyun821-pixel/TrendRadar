import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { chatOpenRouter, NEMOTRON_ULTRA, NEMOTRON_SUPER } from '../server/openrouter';
import { FUNCTION_DECLARATIONS } from '../server/gemma';
import { parseActionBlock, TOOL_DEFS, openaiTools } from '../server/agent';
import { parseGrokStream, parseCodexJsonl, grokArgs, codexArgs, buildPrompt, removeGrokSessionDirs, leftoverSessions, readRegistry, writeRegistry, grokGroupName, isNodeRuntime, isAuthError, GROK_ENV } from '../server/cli';
import { app } from '../server/app';
import { pickModel } from '../src/chat';

afterEach(() => vi.unstubAllGlobals());
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const user = (text: string) => ({ messages: [{ role: 'user' as const, text }] });

describe('공유 도구 정의', () => {
  it('Gemma functionDeclarations 와 OpenAI tools 가 같은 정의에서 나온다', () => {
    const names = TOOL_DEFS.map(t => t.name);
    expect(FUNCTION_DECLARATIONS.map(f => f.name)).toEqual(names);
    expect(openaiTools().map(t => t.function.name)).toEqual(names);
    expect(names).toEqual(expect.arrayContaining(['set_mode', 'toggle_map_mode', 'focus_country', 'get_forecast', 'search_programs', 'get_lifespan', 'search_mro', 'write_report']));
    expect((FUNCTION_DECLARATIONS[0].parameters.properties as any).system.type).toBe('STRING');
    expect((openaiTools()[1].function.parameters.properties as any).flat.type).toBe('boolean');
  });
});

describe('네모트론 (OpenRouter)', () => {
  it('키가 없으면 nokey', async () => {
    const r = await chatOpenRouter(user('안녕'), {});
    expect(r.nokey).toBe(true); expect(r.reply).toContain('키 없음');
  });
  it('tools 경로: tool_calls → 화면 동작·보고서 → 최종 답', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      if (calls.length === 1) return ok({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'set_mode', arguments: '{"system":"자주포"}' } },
        { id: 'b', type: 'function', function: { name: 'get_forecast', arguments: '{"country":"폴란드","system":"자주포"}' } },
        { id: 'c', type: 'function', function: { name: 'write_report', arguments: '{"country":"폴란드","system":"자주포"}' } }] } }] });
      return ok({ choices: [{ message: { role: 'assistant', content: '폴란드 자주포 보고서를 띄웠습니다.' } }] });
    }));
    const r = await chatOpenRouter(user('폴란드 자주포 보고서'), { OPENROUTER_API_KEY: 'k' });
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0].headers.authorization).toBe('Bearer k');
    expect(calls[0].body.model).toBe(NEMOTRON_ULTRA);
    expect(calls[0].body.tools.map((t: any) => t.function.name)).toContain('write_report');
    const toolMsgs = calls[1].body.messages.filter((m: any) => m.role === 'tool');
    expect(toolMsgs.map((m: any) => m.tool_call_id)).toEqual(['a', 'b', 'c']);
    expect(JSON.parse(toolMsgs[1].content)[0].country).toBe('폴란드');
    expect(r.actions).toContainEqual({ type: 'set_mode', system: 'sph' });
    expect(r.actions).toContainEqual({ type: 'focus_country', country: 'POL' });
    expect(r.reports[0]).toContain('폴란드');
    expect(r.tools).toEqual(['set_mode', 'get_forecast', 'write_report']);
    expect(r.model).toBe(NEMOTRON_ULTRA);
    expect(r.reply).toContain('보고서');
  });
  it('Ultra 429 → Super 로 전환, 응답 모델 표시', async () => {
    const models: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body); models.push(b.model);
      if (b.model === NEMOTRON_ULTRA) return ok({ error: { message: 'rate limited', code: 429 } }, 429);
      return ok({ choices: [{ message: { role: 'assistant', content: '안녕하세요' } }] });
    }));
    const r = await chatOpenRouter(user('안녕'), { OPENROUTER_API_KEY: 'k' });
    expect(models).toEqual([NEMOTRON_ULTRA, NEMOTRON_SUPER]);
    expect(r.model).toBe(NEMOTRON_SUPER); expect(r.reply).toBe('안녕하세요');
  });
  it('200 이지만 본문 error(5xx) 도 전환, 타임아웃/네트워크 오류도 전환', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body); n++;
      if (b.model === NEMOTRON_ULTRA) { if (n === 1) throw new Error('timeout'); }
      return ok({ choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    }));
    const r = await chatOpenRouter(user('x'), { OPENROUTER_API_KEY: 'k' });
    expect(r.model).toBe(NEMOTRON_SUPER);
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => JSON.parse(init.body).model === NEMOTRON_ULTRA ? ok({ error: { code: 503, message: 'down' } }) : ok({ choices: [{ message: { content: 'ok2' } }] })));
    expect((await chatOpenRouter(user('x'), { OPENROUTER_API_KEY: 'k' })).model).toBe(NEMOTRON_SUPER);
  });
  it('401 은 전환하지 않고 키 오류', async () => {
    const f = vi.fn(async () => ok({ error: { message: 'bad key', code: 401 } }, 401));
    vi.stubGlobal('fetch', f);
    const r = await chatOpenRouter(user('x'), { OPENROUTER_API_KEY: 'k' });
    expect(f).toHaveBeenCalledTimes(1); expect(r.error).toBe('OpenRouter 키 오류');
  });
  it('둘 다 실패하면 오류', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    const r = await chatOpenRouter(user('x'), { OPENROUTER_API_KEY: 'k' });
    expect(r.error).toBe('AI 오류 503');
  });
  it('도구 미지원(404 tool use) → 텍스트 액션 블록 프로토콜', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body); bodies.push(b);
      if (b.tools) return ok({ error: { message: 'No endpoints found that support tool use', code: 404 } }, 404);
      if (bodies.length === 2) return ok({ choices: [{ message: { content: '조회하겠습니다.\n```json\n{"tools":[{"name":"get_forecast","args":{"country":"폴란드","system":"자주포"}},{"name":"focus_country","args":{"country":"폴란드"}}]}\n```' } }] });
      return ok({ choices: [{ message: { content: '폴란드 자주포 교체는 2058~2064년 예측입니다.\n```json\n{"actions":[{"type":"set_mode","system":"자주포"}]}\n```' } }] });
    }));
    const r = await chatOpenRouter(user('폴란드 자주포 언제?'), { OPENROUTER_API_KEY: 'k' });
    expect(bodies[1].tools).toBeUndefined();
    expect(bodies[1].messages[0].content).toContain('"tools"');
    expect(bodies[2].messages.at(-1).content).toContain('get_forecast');
    expect(r.model).toBe(NEMOTRON_ULTRA);
    expect(r.actions).toContainEqual({ type: 'focus_country', country: 'POL' });
    expect(r.actions).toContainEqual({ type: 'set_mode', system: 'sph' });
    expect(r.reply).toBe('폴란드 자주포 교체는 2058~2064년 예측입니다.');
  });
});

describe('액션 블록 파서', () => {
  it('```json 블록, 별칭, 잘못된 항목 무시', () => {
    const p = parseActionBlock('답입니다.\n```json\n{"actions":[{"type":"focus_country","country":"폴란드"},{"type":"report","country":"폴란드"},{"type":"rm -rf"}]}\n```');
    expect(p.text).toBe('답입니다.');
    expect(p.calls).toEqual([{ name: 'focus_country', args: { country: '폴란드' } }, { name: 'write_report', args: { country: '폴란드' } }]);
  });
  it('펜스 없는 끝 JSON, 꼬리 쉼표 등 깨진 JSON 은 본문 유지', () => {
    expect(parseActionBlock('ok {"actions":[{"type":"toggle_map_mode","flat":true}]}').calls).toEqual([{ name: 'toggle_map_mode', args: { flat: true } }]);
    const bad = parseActionBlock('본문 ```json\n{"actions":[,]}\n```');
    expect(bad.calls).toEqual([]);
    expect(parseActionBlock('코드 예시 ```js\nconst a = 1\n```').calls).toEqual([]);
    expect(parseActionBlock('```json\n{"report":{"country":"폴란드","system":"자주포"}}\n```').calls[0].name).toBe('write_report');
  });
});

describe('CLI 모델 (그록 빌드·코덱스)', () => {
  it('그록 인자: 최신 모델·xhigh·세션 uuid·읽기 전용 권한·MCP 허용', () => {
    const a = grokArgs({ promptFile: 'p.txt', sid: '11111111-1111-4111-8111-111111111111', cwd: 'C:\\w\\.runtime\\grok' });
    const v = (f: string) => a[a.indexOf(f) + 1];
    expect(v('-m')).toBe('grok-4.7'); expect(v('--reasoning-effort')).toBe('xhigh'); expect(v('-s')).toBe('11111111-1111-4111-8111-111111111111');
    expect(v('--permission-mode')).toBe('dontAsk'); expect(v('--allow')).toBe('MCPTool(procurement__*)'); expect(v('--output-format')).toBe('streaming-json');
    expect(a).toContain('--no-subagents'); expect(a).toContain('--no-plan');
    expect(v('--tools')).toBe('web_search,web_fetch');
    expect(v('--system-prompt-override').length).toBeLessThan(200);
    expect(a.filter(x => x === '--allow')).toHaveLength(2); expect(a).toContain('WebFetch');
    expect(a).not.toContain('--disable-web-search');
  });
  it('그록 환경 변수: 메모리·Claude/Cursor 호환 스캔 끔', () => {
    expect(GROK_ENV.GROK_MEMORY).toBe('0');
    expect(GROK_ENV.GROK_CLAUDE_MCPS_ENABLED).toBe('false'); expect(GROK_ENV.GROK_CURSOR_RULES_ENABLED).toBe('false');
  });
  it('코덱스 인자: ephemeral·read-only·xhigh·호출별 MCP 설정', () => {
    const a = codexArgs({ cwd: 'C:\\w\\.runtime\\codex', node: 'C:\\Program Files\\nodejs\\node.exe', tsx: 'C:\\w\\tsx.mjs', mcp: 'C:\\w\\mcp\\server.ts' });
    expect(a.slice(0, 6)).toEqual(['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only']);
    expect(a).toContain('web_search="live"'); expect(a).toContain('mcp_servers.procurement.default_tools_approval_mode="approve"'); expect(a).toContain('project_doc_max_bytes=0');
    const off = a.flatMap((x, i) => x === '--disable' ? [a[i + 1]] : []);
    expect(off).toEqual(expect.arrayContaining(['shell_tool', 'unified_exec', 'view_image', 'multi_agent', 'plugins', 'apps', 'image_generation']));
    expect(off).not.toContain('web_search');
    expect(codexArgs({ cwd: 'x', node: 'n', tsx: 't', mcp: 'm', instructionsFile: 'C:\\t\\i.md' })).toContain('model_instructions_file="C:\\\\t\\\\i.md"');
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-6.1-sol');
    expect(a).toContain('model_reasoning_effort="xhigh"');
    expect(a).toContain('mcp_servers.procurement.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"');
    expect(a.find(x => x.startsWith('mcp_servers.procurement.args='))).toBe('mcp_servers.procurement.args=["C:\\\\w\\\\tsx.mjs","C:\\\\w\\\\mcp\\\\server.ts"]');
    expect(a.at(-1)).toBe('-');
  });
  it('프롬프트: MCP 사용·액션 블록 안내·이전 대화', () => {
    const p = buildPrompt({ messages: [{ role: 'user', text: '안녕' }, { role: 'model', text: '네' }, { role: 'user', text: '폴란드 자주포' }], state: { mode: 'sph' } });
    expect(p).toContain('procurement MCP'); expect(p).toContain('"actions"'); expect(p).toContain('도우미: 네'); expect(p.trim().endsWith('사용자: 폴란드 자주포')).toBe(true);
  });
  it('그록 streaming-json: 마지막 도구 호출 뒤 텍스트가 답, 도구 이름 추출', () => {
    const out = [
      { type: 'text', data: '조회하겠습니다.' },
      { type: 'tool_call', toolCallId: '1', toolName: 'search_tool', rawInput: { query: 'forecast' } },
      { type: 'tool_call', toolCallId: '2', toolName: 'use_tool', rawInput: { name: 'procurement__forecast', arguments: { country: '폴란드' } } },
      { type: 'tool_call_update', toolCallId: '2', status: 'completed' },
      { type: 'text', data: '폴란드 자주포는 2058~2064년 예측.\n```json\n{"actions":[{"type":"focus_country","country":"폴란드"}]}\n```' },
      { type: 'end', stopReason: 'end_turn', sessionId: 'x', usage: { input_tokens: 4000, cache_read_input_tokens: 1000, output_tokens: 50 } },
    ].map(x => JSON.stringify(x)).join('\n');
    const p = parseGrokStream(out);
    expect(p.text.startsWith('폴란드 자주포는')).toBe(true);
    expect(p.tools).toEqual(['forecast']);
    expect(p.usage).toEqual({ input: 5000, cached: 1000, output: 50 });
    expect(p.auth).toBe(false);
  });
  it('그록 로그인 오류 감지', () => {
    const p = parseGrokStream('{"type":"error","message":"Not logged in. Run `grok login` to authenticate."}');
    expect(p.text).toBe(''); expect(p.auth).toBe(true);
    expect(parseGrokStream('', 'Error: authentication required (401)').auth).toBe(true);
    expect(isAuthError('network timeout')).toBe(false);
  });
  it('코덱스 JSONL: 마지막 agent_message, MCP 도구, 실패', () => {
    const out = [
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: '조회하겠습니다.' } },
      { type: 'item.completed', item: { id: 'i1', type: 'mcp_tool_call', server: 'procurement', tool: 'forecast', arguments: { country: '폴란드' }, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: '2058~2064년 예측.\n```json\n{"actions":[]}\n```' } },
      { type: 'turn.completed', usage: { input_tokens: 7177, cached_input_tokens: 0, output_tokens: 30 } },
    ].map(x => JSON.stringify(x)).join('\n');
    const p = parseCodexJsonl(out);
    expect(p.text.startsWith('2058~2064년')).toBe(true); expect(p.tools).toEqual(['forecast']); expect(p.usage?.input).toBe(7177);
    const f = parseCodexJsonl('{"type":"turn.failed","error":{"message":"401 Unauthorized: please log in"}}');
    expect(f.error).toContain('401'); expect(f.auth).toBe(true);
  });
  it('세션 정리: uuid 디렉터리 삭제, 앱 전용 그룹이 비면 그룹도 삭제, 남은 세션 찾기', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'grok-sessions-'));
    const own = grokGroupName('C:\\w\\.runtime\\grok');
    const sid = '01a13f68-64c4-7ea3-bbf6-26759d4d5a96', other = '01a13f5a-48c7-72c3-9a74-9005516a8ad5', stale = '22222222-2222-4222-8222-222222222222';
    mkdirSync(path.join(root, own, sid), { recursive: true }); writeFileSync(path.join(root, own, sid, 'updates.jsonl'), '{}');
    mkdirSync(path.join(root, own, stale), { recursive: true });
    mkdirSync(path.join(root, 'C%3A%5CUsers%5Cuser', other), { recursive: true }); // 사용자 본인 세션: 건드리지 않음
    const reg = path.join(root, 'reg.json');
    writeRegistry(reg, [sid, sid, 'not-a-uuid'], fs);
    expect(readRegistry(reg, fs)).toEqual([sid, 'not-a-uuid']);
    expect(leftoverSessions(readRegistry(reg, fs), root, own, fs, path).sort()).toEqual([sid, stale].sort());
    expect(removeGrokSessionDirs(root, sid, fs, path, own)).toBe(1);
    expect(existsSync(path.join(root, own))).toBe(true); // stale 남아 있음
    expect(removeGrokSessionDirs(root, stale, fs, path, own)).toBe(1);
    expect(existsSync(path.join(root, own))).toBe(false);
    expect(existsSync(path.join(root, 'C%3A%5CUsers%5Cuser', other))).toBe(true);
    expect(removeGrokSessionDirs(root, '../../etc', fs, path, own)).toBe(0);
    expect(readdirSync(root).sort()).toEqual(['C%3A%5CUsers%5Cuser', 'reg.json']);
  });
  it('Cloudflare Workers 에서는 로컬 모델 비활성', () => {
    expect(isNodeRuntime()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(isNodeRuntime()).toBe(false);
  });
});

describe('모델 API', () => {
  it('GET /api/models: 4개, 기본 젬마, LOCAL_CLI=0 이면 로컬 모델 숨김', async () => {
    const r = await app.request('/api/models', {}, { LOCAL_CLI: '0' });
    const j = await r.json();
    expect(j.default).toBe('gemma');
    expect(j.models.map((m: any) => m.name)).toEqual(['그록 빌드', '코덱스', '젬마', '네모트론']);
    expect(j.models.filter((m: any) => m.available).map((m: any) => m.id)).toEqual(['gemma', 'nemotron']);
  });
  it('POST /api/chat model=nemotron 키 없음, 모르는 모델', async () => {
    const post = (b: unknown) => app.request('/api/chat', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } }, { LOCAL_CLI: '0' });
    const j = await (await post({ model: 'nemotron', ...user('hi') })).json();
    expect(j.nokey).toBe(true); expect(j.reply).toBe('OpenRouter 키 없음');
    expect((await (await post({ model: 'x', ...user('hi') })).json()).error).toBe('모르는 모델');
    expect((await (await post({ model: 'grok', ...user('hi') })).json()).error).toBeTruthy();
  });
  it('!모델 이름 해석', () => {
    const ms = [{ id: 'grok', name: '그록 빌드', available: true }, { id: 'gemma', name: '젬마', available: true }];
    expect(pickModel('그록 빌드', ms)).toBe('grok'); expect(pickModel('코덱스', ms)).toBe('codex'); expect(pickModel('Gemma', ms)).toBe('gemma'); expect(pickModel('네모트론', ms)).toBe('nemotron'); expect(pickModel('foo', ms)).toBeNull();
  });
});
