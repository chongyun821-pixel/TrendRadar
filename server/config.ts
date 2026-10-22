import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, delimiter, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function readVars(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return Object.fromEntries(readFileSync(path, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).flatMap(line => {
    const match = line.trim().match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) return [];
    return [[match[1], match[2].replace(/^(["'])(.*)\1$/, '$2')]];
  }));
}
const local = { ...readVars(join(ROOT, '.secrets')), ...process.env };
export const DATA_ROOT = resolve(ROOT, local.H5S_DATA_DIR || '.local');
export const RADAR_ROOT = resolve(ROOT, local.RADAR_PROJECT_PATH || '../procurement-radar');
const radar = readVars(join(RADAR_ROOT, '.secrets'));
export const config = {
  port: Number(local.PORT || 4318),
  databaseUrl: local.RADAR_DATABASE_URL || radar.DATABASE_URL || '',
  schema: local.RADAR_PG_SCHEMA || radar.RADAR_PG_SCHEMA || 'trendradar',
  supabaseUrl: local.RADAR_SUPABASE_URL || radar.SUPABASE_URL || '',
  supabaseKey: local.RADAR_SUPABASE_KEY || radar.SUPABASE_SECRET_KEY || radar.SUPABASE_SERVICE_ROLE_KEY || '',
  bucket: local.RADAR_STORAGE_BUCKET || radar.SUPABASE_STORAGE_BUCKET || 'trendradar-private',
  radarStorage: resolve(RADAR_ROOT, radar.RADAR_STORAGE_DIR || '.local'),
  chrome: local.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => existsSync(p)),
};
export function codexCommand(): { command: string; args: string[] } {
  if (local.CODEX_BIN) return { command: local.CODEX_BIN, args: [] };
  // Resolve the npm JavaScript launcher directly: no shell, .cmd quoting, or visible window.
  for (const base of (process.env.PATH || '').split(delimiter)) {
    const js = join(base, 'node_modules/@openai/codex/bin/codex.js');
    if (existsSync(js)) {
      const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
      const target = process.platform === 'win32' ? `${cpu}-pc-windows-msvc` : process.platform === 'darwin' ? `${cpu}-apple-darwin` : `${cpu}-unknown-linux-musl`;
      const packageName = `@openai/codex-${process.platform}-${process.arch}`;
      try {
        const manifest = createRequire(js).resolve(`${packageName}/package.json`);
        const binary = join(dirname(manifest), 'vendor', target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existsSync(binary)) return { command: binary, args: [] };
      } catch { /* Older installations use the JavaScript entry point. */ }
      return { command: process.execPath, args: [js] };
    }
    const exe = join(base, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (existsSync(exe)) return { command: exe, args: [] };
  }
  throw new Error('Codex CLI를 찾을 수 없습니다. 설치 후 codex login을 실행해주세요.');
}
export function codexChildEnv(extra: Record<string, string> = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (/DATABASE_URL|SUPABASE.*KEY|RADAR_SUPABASE|RADAR_DATABASE/.test(key)) delete env[key];
  return env;
}
export function safeError(error: unknown): string {
  let s = error instanceof Error ? error.message : String(error);
  for (const value of [config.databaseUrl, config.supabaseKey]) if (value) s = s.replaceAll(value, '[비공개 연결정보]');
  return s.replace(/postgres(?:ql)?:\/\/\S+/gi, '[비공개 DB 주소]').replace(/\b(?:sk-[a-zA-Z0-9_-]+|sb_secret_[a-zA-Z0-9_-]+|eyJ[a-zA-Z0-9_.-]{40,})/g, '[비공개 키]');
}
