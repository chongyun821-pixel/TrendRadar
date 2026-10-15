// Cloudflare Pages Functions: /api/* → Hono 앱 (server/app.ts)
import { handle } from 'hono/cloudflare-pages';
import { app } from '../../server/app';

export const onRequest = handle(app);
