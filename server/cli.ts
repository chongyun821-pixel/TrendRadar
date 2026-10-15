/**
 * 로컬 CLI 모델: 그록 빌드(grok -p) · 코덱스(codex exec). Node 전용 — Cloudflare(Workers)에서는 비활성.
 * node:* 모듈은 동적 import 로만 불러 Workers 번들에 들어가지 않게 한다.
 */
import { systemPrompt, recentMessages, newOut, parseActionBlock, applyPageCalls, ACTION_BLOCK_GUIDE, type ChatIn, type ChatOut } from './agent';
import type { Env } from './gemma';

export const GROK_MODEL = 'grok-4.7';
export const GROK_EFFORT = 'xhigh';
export const CODEX_MODEL = 'gpt-6.1-sol';
export const CODEX_EFFORT = 'xhigh';
export const CLI_TIMEOUT_MS = 5 * 60 * 1000;

/** CLI 기본 시스템 프롬프트 대체(짧게) — 입력 토큰 절약 */
export const CLI_SYSTEM = '너는 「무기조달사업예상」 웹앱의 한국어 도우미다. 데이터는 procurement MCP 도구로 조회하고, 필요할 때만 웹 검색·웹 페이지 열기를 쓴다. 파일 수정·셸은 쓰지 않는다. 짧게 답한다.';
/** 그록: 기본 도구 중 웹만 남김(MCP 메타 도구 search_tool/use_tool 은 항상 유지) */
export const GROK_TOOLS = 'web_search,web_fetch';
/** 그록: Claude/Cursor 호환 스캔(규칙·스킬·훅·MCP·에이전트)과 메모리 끄기 */
export const GROK_ENV: Record<string, string> = {
  GROK_MEMORY: '0', GROK_DISABLE_AUTOUPDATER: '1',
  ...Object.fromEntries(['CLAUDE', 'CURSOR'].flatMap(v => ['AGENTS', 'HOOKS', 'MCPS', 'RULES', 'SKILLS'].map(k => [`GROK_${v}_${k}_ENABLED`, 'false']))),
};
/** 코덱스: 사용자 config 무시 + 웹 검색만 남기고 나머지 기능 끔 (모두 호출별 -c/--disable, 전역 설정 변경 없음) */
export const CODEX_CONFIG = ['web_search="live"', 'include_permissions_instructions=false', 'include_apps_instructions=false', 'include_collaboration_mode_instructions=false', 'include_environment_context=false', 'project_doc_max_bytes=0', 'history.persistence="none"'];
export const CODEX_DISABLE = ('apps goals image_generation browser_use browser_use_external browser_use_full_cdp_access browser_annotation_api computer_use in_app_browser in_app_chat in_app_dictation in_app_local_automation in_app_updates in_app_voice hooks multi_agent plugins plugin_sharing remote_plugin realtime_conversation '
  + 'shell_tool shell_snapshot unified_exec unified_exec_tty view_image skill_mcp_dependency_install skill_search sleep_tool tool_suggest worktrees workspace_dependencies guardian_approval mentions_v2 write_stdin_approval').split(' ');

type Mods = { cp: typeof import('node:child_process'); fs: typeof import('node:fs'); path: typeof import('node:path'); os: typeof import('node:os'); crypto: typeof import('node:crypto') };
const G = globalThis as any;
const S: { busy: Record<string, boolean>; cleaned?: boolean; avail?: Record<string, boolean> } = (G.__prCli ??= { busy: {} });

export function isNodeRuntime() {
  const p = (globalThis as any).process;
  if (!p?.versions?.node) return false;
  if ((globalThis as any).navigator?.userAgent === 'Cloudflare-Workers') return false;
  return true;
}
let modsP: Promise<Mods | null> | null = null;
export function nodeMods(): Promise<Mods | null> {
  if (!isNodeRuntime()) return Promise.resolve(null);
  const imp = (s: string) => import(/* @vite-ignore */ s);
  return (modsP ??= Promise.all(['node:child_process', 'node:fs', 'node:path', 'node:os', 'node:crypto'].map(imp))
    .then(([cp, fs, path, os, crypto]) => ({ cp, fs, path, os, crypto }) as Mods).catch(() => null));
}

/* ───────── 순수 함수 (테스트 대상) ───────── */

export function buildPrompt(input: ChatIn): string {
  const hist = recentMessages(input);
  const last = hist.pop();
  return [
    systemPrompt(input.state),
    '데이터·수치는 procurement MCP 도구(forecast, list_forecasts, search_programs, get_lifespan, search_mro, get_inventory, write_report)로만 조회한다. 파일 수정·셸·웹 검색은 하지 않는다.',
    ACTION_BLOCK_GUIDE,
    ...(hist.length ? ['', '이전 대화:', ...hist.map(m => `${m.role === 'user' ? '사용자' : '도우미'}: ${m.text}`)] : []),
    '', `사용자: ${last?.text ?? ''}`,
  ].join('\n');
}

export function grokArgs(o: { promptFile: string; sid: string; cwd: string; model?: string; effort?: string }) {
  return ['--prompt-file', o.promptFile, '-m', o.model || GROK_MODEL, '--reasoning-effort', o.effort || GROK_EFFORT,
    '--output-format', 'streaming-json', '-s', o.sid, '--cwd', o.cwd,
    '--tools', GROK_TOOLS, '--no-plan', '--no-subagents', '--system-prompt-override', CLI_SYSTEM,
    '--permission-mode', 'dontAsk', '--allow', 'MCPTool(procurement__*)', '--allow', 'WebFetch',
    '--max-turns', '12'];
}

export function codexArgs(o: { cwd: string; node: string; tsx: string; mcp: string; model?: string; effort?: string; instructionsFile?: string }) {
  return ['exec', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never',
    '-m', o.model || CODEX_MODEL, '-c', `model_reasoning_effort=${JSON.stringify(o.effort || CODEX_EFFORT)}`,
    ...CODEX_CONFIG.flatMap(c => ['-c', c]), ...CODEX_DISABLE.flatMap(f => ['--disable', f]),
    ...(o.instructionsFile ? ['-c', `model_instructions_file=${JSON.stringify(o.instructionsFile)}`] : []),
    '-c', `mcp_servers.procurement.command=${JSON.stringify(o.node)}`, '-c', `mcp_servers.procurement.args=${JSON.stringify([o.tsx, o.mcp])}`,
    '-c', 'mcp_servers.procurement.default_tools_approval_mode="approve"', // 읽기 전용 도구만 있음
    '--json', '-C', o.cwd, '-'];
}

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
    else if (e.type === 'end' && e.usage) usage = { input: (e.usage.input_tokens ?? 0) + (e.usage.cache_read_input_tokens ?? 0), cached: e.usage.cache_read_input_tokens ?? 0, output: e.usage.output_tokens ?? 0 };
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
    else if (e.type === 'error') error = String(e.message ?? 'error');
    else if (e.type === 'turn.failed') error = String(e.error?.message ?? 'turn failed');
    else if (e.type === 'turn.completed' && e.usage) usage = { input: e.usage.input_tokens ?? 0, cached: e.usage.cached_input_tokens ?? 0, output: e.usage.output_tokens ?? 0 };
  }
  const errText = `${error ?? ''}\n${text ? '' : stderr}`;
  return { text: text.trim(), usage, tools, error: error ?? (!text && stderr.trim() ? stderr.trim().slice(-300) : undefined), auth: isAuthError(errText) };
}

/* ───────── 그록 세션 정리 ───────── */

type FsLike = Pick<typeof import('node:fs'), 'existsSync' | 'readdirSync' | 'rmSync' | 'readFileSync' | 'writeFileSync' | 'mkdirSync'>;
type PathLike = Pick<typeof import('node:path'), 'join'>;

/** ~/.grok/sessions/<그룹>/<uuid> 를 모두 지운다. 그룹이 앱 전용(ownGroup)이고 비면 그룹도 지운다 */
export function removeGrokSessionDirs(root: string, sid: string, fs: FsLike, path: PathLike, ownGroup?: string): number {
  if (!/^[0-9a-f-]{36}$/i.test(sid) || !fs.existsSync(root)) return 0;
  let n = 0;
  for (const g of fs.readdirSync(root)) {
    const d = path.join(root, g, sid);
    if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); n++; }
  }
  if (ownGroup) {
    const gd = path.join(root, ownGroup);
    try { if (fs.existsSync(gd) && !fs.readdirSync(gd).some(x => /^[0-9a-f-]{36}$/i.test(x))) fs.rmSync(gd, { recursive: true, force: true }); } catch { /* 무시 */ }
  }
  return n;
}
export const grokGroupName = (cwd: string) => encodeURIComponent(cwd);

export function readRegistry(file: string, fs: FsLike): string[] {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j.filter(x => typeof x === 'string') : []; } catch { return []; }
}
export function writeRegistry(file: string, ids: string[], fs: FsLike) { fs.writeFileSync(file, JSON.stringify([...new Set(ids)])); }

/** 등록된(또는 앱 전용 그룹에 남은) 세션을 모두 지울 목록 */
export function leftoverSessions(registry: string[], root: string, ownGroup: string, fs: FsLike, path: PathLike): string[] {
  const ids = new Set(registry);
  const gd = path.join(root, ownGroup);
  try { if (fs.existsSync(gd)) for (const x of fs.readdirSync(gd)) if (/^[0-9a-f-]{36}$/i.test(x)) ids.add(x); } catch { /* 무시 */ }
  return [...ids].filter(x => /^[0-9a-f-]{36}$/i.test(x));
}

/* ───────── 실행 ───────── */

interface Paths { root: string; grokDir: string; codexDir: string; registry: string; instructions: string; sessionsRoot: string; grokBin: string; home: string }
async function paths(m: Mods, env: Env): Promise<Paths> {
  const root = process.cwd();
  const home = m.os.homedir();
  // 저장소 밖 빈 작업 폴더: AGENTS.md·프로젝트 규칙이 로드되지 않게
  const rt = env.CLI_RUNTIME_DIR || m.path.join(m.os.tmpdir(), 'procurement-radar-cli');
  const grokDir = m.path.join(rt, 'grok'), codexDir = m.path.join(rt, 'codex');
  for (const d of [grokDir, codexDir]) m.fs.mkdirSync(d, { recursive: true });
  const grokBin = env.GROK_BIN || m.path.join(home, '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok');
  return { root, grokDir, codexDir, registry: m.path.join(rt, 'grok-sessions.json'), instructions: m.path.join(rt, 'codex-instructions.md'), sessionsRoot: m.path.join(process.env.GROK_HOME || m.path.join(home, '.grok'), 'sessions'), grokBin, home };
}

function codexCommand(m: Mods, env: Env): { cmd: string; pre: string[] } | null {
  const bin = env.CODEX_BIN;
  const wrap = (p: string) => /\.m?js$/i.test(p) ? { cmd: process.execPath, pre: [p] } : /\.(cmd|bat)$/i.test(p) ? { cmd: process.env.ComSpec || 'cmd.exe', pre: ['/d', '/s', '/c', p] } : { cmd: p, pre: [] };
  if (bin) return wrap(bin);
  if (process.platform === 'win32') {
    const js = m.path.join(process.env.APPDATA || m.path.join(m.os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (m.fs.existsSync(js)) return wrap(js);
    const r = m.cp.spawnSync('where', ['codex.cmd'], { encoding: 'utf8', windowsHide: true });
    const p = r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
    return p ? wrap(p) : null;
  }
  const r = m.cp.spawnSync('which', ['codex'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? { cmd: r.stdout.trim(), pre: [] } : null;
}

export async function localAvailability(env: Env): Promise<{ grok: boolean; codex: boolean }> {
  if (env.LOCAL_CLI === '0') return { grok: false, codex: false };
  const m = await nodeMods(); if (!m) return { grok: false, codex: false };
  if (!S.avail) {
    const p = await paths(m, env);
    S.avail = { grok: m.fs.existsSync(p.grokBin), codex: !!codexCommand(m, env) };
  }
  return { grok: !!S.avail.grok, codex: !!S.avail.codex };
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', ...extra };
  for (const k of ['GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) delete e[k]; // 앱 비밀값은 자식 프로세스에 넘기지 않음
  return e;
}

function run(m: Mods, cmd: string, args: string[], o: { cwd: string; input?: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false, done = false;
    const p = m.cp.spawn(cmd, args, { cwd: o.cwd, env: childEnv(o.env), windowsHide: true, shell: false });
    const kill = () => {
      if (p.pid == null) return;
      if (process.platform === 'win32') m.cp.spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      else p.kill('SIGKILL');
    };
    const t = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs);
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', d => { stdout += d; }); p.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const fin = (code: number | null) => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout, stderr, timedOut }); };
    p.on('error', e => { stderr += String(e); fin(-1); });
    p.on('close', fin);
    p.stdin.on('error', () => {});
    p.stdin.end(o.input ?? '');
  });
}

async function deleteGrokSession(m: Mods, p: Paths, sid: string) {
  try { await run(m, p.grokBin, ['sessions', 'delete', sid], { cwd: p.grokDir, timeoutMs: 20000 }); } catch { /* 디렉터리 삭제로 대체 */ }
  try { removeGrokSessionDirs(p.sessionsRoot, sid, m.fs, m.path, grokGroupName(p.grokDir)); } catch { /* 무시 */ }
  writeRegistry(p.registry, readRegistry(p.registry, m.fs).filter(x => x !== sid), m.fs);
}

/** 서버 시작 시 1회: 앱이 남긴 그록 세션 삭제 */
export async function cleanupLeftovers(env: Env = {}): Promise<number> {
  if (S.cleaned) return 0; S.cleaned = true;
  const m = await nodeMods(); if (!m) return 0;
  try {
    const p = await paths(m, env);
    if (!m.fs.existsSync(p.grokBin)) return 0;
    const ids = leftoverSessions(readRegistry(p.registry, m.fs), p.sessionsRoot, grokGroupName(p.grokDir), m.fs, m.path);
    for (const id of ids) await deleteGrokSession(m, p, id);
    return ids.length;
  } catch { return 0; }
}

function finish(out: ChatOut, parsed: CliParsed): ChatOut {
  const b = parseActionBlock(parsed.text);
  applyPageCalls(b.calls, out);
  out.tools.unshift(...parsed.tools);
  if (parsed.usage) out.usage = parsed.usage;
  out.reply = b.text || (out.reports.length ? '보고서를 표시했습니다.' : '…');
  return out;
}

export async function chatGrok(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut(); out.model = env.GROK_MODEL || GROK_MODEL;
  const m = await nodeMods();
  if (!m || !(await localAvailability(env)).grok) return { ...out, error: '로컬 전용 모델' };
  if (S.busy.grok) return { ...out, error: '그록 실행 중. 잠시 후 다시 시도' };
  S.busy.grok = true;
  const p = await paths(m, env);
  await cleanupLeftovers(env);
  const sid = m.crypto.randomUUID();
  const promptFile = m.path.join(p.grokDir, `prompt-${sid}.txt`);
  try {
    writeRegistry(p.registry, [...readRegistry(p.registry, m.fs), sid], m.fs);
    m.fs.writeFileSync(promptFile, buildPrompt(input), 'utf8');
    const r = await run(m, p.grokBin, grokArgs({ promptFile, sid, cwd: p.grokDir, model: env.GROK_MODEL, effort: env.GROK_EFFORT }), { cwd: p.grokDir, timeoutMs: CLI_TIMEOUT_MS, env: GROK_ENV });
    const parsed = parseGrokStream(r.stdout, r.stderr);
    if (parsed.auth && !parsed.text) return { ...out, error: '그록 로그인 필요' };
    if (r.timedOut) return { ...out, error: '그록 시간 초과' };
    if (!parsed.text) return { ...out, error: '그록 오류', detail: (parsed.error ?? `exit ${r.code}`).slice(0, 300) };
    return finish(out, parsed);
  } finally {
    try { m.fs.rmSync(promptFile, { force: true }); } catch { /* 무시 */ }
    await deleteGrokSession(m, p, sid);
    S.busy.grok = false;
  }
}

export async function chatCodex(input: ChatIn, env: Env): Promise<ChatOut> {
  const out = newOut(); out.model = env.CODEX_MODEL || CODEX_MODEL;
  const m = await nodeMods();
  if (!m || !(await localAvailability(env)).codex) return { ...out, error: '로컬 전용 모델' };
  const c = codexCommand(m, env);
  if (!c) return { ...out, error: '코덱스 없음' };
  if (S.busy.codex) return { ...out, error: '코덱스 실행 중. 잠시 후 다시 시도' };
  S.busy.codex = true;
  try {
    const p = await paths(m, env);
    m.fs.writeFileSync(p.instructions, CLI_SYSTEM, 'utf8');
    const args = codexArgs({ cwd: p.codexDir, node: process.execPath, tsx: m.path.join(p.root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), mcp: m.path.join(p.root, 'mcp', 'server.ts'), model: env.CODEX_MODEL, effort: env.CODEX_EFFORT, instructionsFile: p.instructions });
    const r = await run(m, c.cmd, [...c.pre, ...args], { cwd: p.codexDir, input: buildPrompt(input), timeoutMs: CLI_TIMEOUT_MS });
    const parsed = parseCodexJsonl(r.stdout, r.stderr);
    if (parsed.auth && !parsed.text) return { ...out, error: '코덱스 로그인 필요' };
    if (r.timedOut) return { ...out, error: '코덱스 시간 초과' };
    if (!parsed.text) return { ...out, error: '코덱스 오류', detail: (parsed.error ?? `exit ${r.code}`).slice(0, 300) };
    return finish(out, parsed);
  } finally { S.busy.codex = false; }
}
