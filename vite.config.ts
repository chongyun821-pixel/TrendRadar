import { defineConfig, type Plugin } from 'vite';
import { getRequestListener } from '@hono/node-server';
import { loadDevVars } from './server/devvars';
import { rememberRemote, localServerUrl } from './server/local-only';

/** 개발 서버에서 /api/* 를 Cloudflare와 같은 Hono 핸들러로 처리 */
function api(): Plugin {
  return {
    name: 'procurement-api',
    configureServer(server) {
      const listener = getRequestListener(async (req, { incoming }) => {
        rememberRemote(req, incoming.socket.remoteAddress); // 화면 허브 등 로컬 전용 경로 확인용
        const { app } = await server.ssrLoadModule('/server/app.ts');
        return app.fetch(req, { ...process.env, ...loadDevVars() });
      });
      server.middlewares.use((req, res, next) => (req.url?.startsWith('/api/') ? listener(req, res) : next()));
      // MCP 서버(자식 프로세스)가 화면 명령을 보낼 이 앱 서버 주소
      server.httpServer?.once('listening', () => { const a = server.httpServer?.address(); if (a && typeof a === 'object') process.env.RADAR_APP_URL = localServerUrl(a.address, a.port); });
      // 시작 시 앱이 남긴 그록 세션 정리
      server.httpServer?.once('listening', () => { server.ssrLoadModule('/server/cli.ts').then(m => m.cleanupLeftovers({ ...process.env, ...loadDevVars() })).catch(() => {}); });
      server.httpServer?.once('listening', () => { server.ssrLoadModule('/server/runs.ts').then(m => m.recoverRuns()).catch(console.error); });
    },
  };
}

export default defineConfig({
  plugins: [api()],
  server: { port: 62356, strictPort: true, host: '127.0.0.1' },
  preview: { port: 62356, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
