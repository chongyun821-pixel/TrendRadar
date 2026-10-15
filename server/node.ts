/** Node 단독 실행: dist 정적 파일 + /api 를 62356 포트로 */
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { app as api } from './app';
import { loadDevVars } from './devvars';

const env = { ...process.env, ...loadDevVars() } as Record<string, string>;
const port = Number(env.PORT || 62356);
if (!existsSync('dist/index.html')) { console.error('dist 없음: 먼저 npm run build'); process.exit(1); }

const root = new Hono();
root.all('/api/*', c => api.fetch(c.req.raw, env));
root.use('/*', serveStatic({ root: './dist' }));
root.get('*', serveStatic({ path: './dist/index.html' }));
serve({ fetch: root.fetch, port, hostname: env.HOST || '0.0.0.0' }, i => console.log(`무기조달사업예상 → http://localhost:${i.port}  (AI 키 ${env.GOOGLE_API_KEY ? '있음' : '없음'})`));
