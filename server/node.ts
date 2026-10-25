/** Node 단독 실행: dist 정적 파일 + /api 를 62356 포트로 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { app as api } from './app';
import { loadDevVars } from './devvars';
import { cleanupLeftovers, ensureMcpServer } from './cli';
import { recoverRuns } from './runs';
import { rememberRemote, localServerUrl } from './local-only';
import { setSettingsReloadHandler } from './settings-secrets';
import { initializeRelay } from './remote-relay';

const env = { ...process.env, ...loadDevVars() } as Record<string, string>;
setSettingsReloadHandler(() => {
  const loaded = loadDevVars();
  for (const key of Object.keys(loaded)) env[key] = loaded[key];
  for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'FIRECRAWL_API_KEY', 'HORUS_DEVICE_NAME']) {
    if (!(key in loaded) && !(key in process.env)) delete env[key];
  }
});
const port = Number(env.PORT || 62356), hostname = env.HOST || '127.0.0.1';
// MCP 서버(자식 프로세스)가 화면 명령을 보낼 이 앱 서버 주소
process.env.RADAR_APP_URL = localServerUrl(hostname, port);
void cleanupLeftovers(env);
await recoverRuns(env);
await initializeRelay();
if (!existsSync('dist/index.html')) { console.error('dist 없음: 먼저 npm run build'); process.exit(1); }
try { await ensureMcpServer(); }
catch (error) { console.error(error instanceof Error ? error.message : '공유 HTTP MCP 서버를 시작하지 못했습니다.'); }

const root = new Hono();
root.all('/api/*', c => api.fetch(c.req.raw, env));
root.use('/*', serveStatic({ root: './dist' }));
root.get('*', serveStatic({ path: './dist/index.html' }));
serve({ fetch: (req, bindings) => { rememberRemote(req, bindings.incoming.socket.remoteAddress); return root.fetch(req, bindings); }, port, hostname }, i => console.log(`무기조달사업예상 → http://localhost:${i.port}  (OpenAI 키 ${env.OPENAI_API_KEY ? '있음' : '없음'})`));
