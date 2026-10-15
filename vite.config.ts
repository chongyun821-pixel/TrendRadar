import { defineConfig, type Plugin } from 'vite';
import { getRequestListener } from '@hono/node-server';
import { loadDevVars } from './server/devvars';

/** 개발 서버에서 /api/* 를 Cloudflare와 같은 Hono 핸들러로 처리 */
function api(): Plugin {
  return {
    name: 'procurement-api',
    configureServer(server) {
      const listener = getRequestListener(async (req) => {
        const { app } = await server.ssrLoadModule('/server/app.ts');
        return app.fetch(req, { ...process.env, ...loadDevVars() });
      });
      server.middlewares.use((req, res, next) => (req.url?.startsWith('/api/') ? listener(req, res) : next()));
    },
  };
}

export default defineConfig({
  plugins: [api()],
  server: { port: 62356, strictPort: true, host: true },
  preview: { port: 62356, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1200 },
});
