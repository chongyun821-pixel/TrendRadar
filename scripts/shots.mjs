// 스크린샷 + 콘솔 오류 확인: 서버(npm run dev 또는 npm start)를 먼저 켜고 `npm run shots`
// Chrome 경로: 환경변수 CHROME_PATH (없으면 설치된 Chrome 채널 사용)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:62356';
const OUT = 'shots';
mkdirSync(OUT, { recursive: true });
const launch = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH; else launch.channel = 'chrome';
const browser = await chromium.launch(launch);
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(String(e)));
const wait = ms => page.waitForTimeout(ms);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForSelector('body.ready');
await wait(1800);
await page.screenshot({ path: `${OUT}/1-globe-general.png` });

await page.click('.modes button[data-sys="sph"]');
await page.evaluate(() => window.__app.focusCountry('VNM'));
await wait(3000);
const vn = await page.evaluate(() => window.__globe.project(108.3, 14.2));
await page.mouse.move(vn.x, vn.y); await wait(80); await page.mouse.move(vn.x + 1, vn.y + 1);
await wait(500);
await page.screenshot({ path: `${OUT}/2-globe-sph-tooltip.png` });

await page.mouse.move(5, 300);
await page.click('.modes button[data-sys="frigate"]');
await page.click('#mapBtn');
await wait(3600);
const pt = await page.evaluate(() => window.__globe.project(113.5, -0.5));
await page.mouse.move(pt.x, pt.y); await wait(60); await page.mouse.move(pt.x + 1, pt.y + 1);
await wait(400);
await page.screenshot({ path: `${OUT}/3-map2d-frigate.png` });

await page.mouse.move(5, 300);
await page.click('#q');
await page.fill('#q', '!help');
await page.keyboard.press('Enter');
await wait(700);
await page.screenshot({ path: `${OUT}/4-chat-help.png` });
await page.fill('#q', '!보고서 베트남 자주포');
await page.keyboard.press('Enter');
await wait(1800);
await page.screenshot({ path: `${OUT}/5-chat-report.png` });
const stats = await page.evaluate(() => window.__stats());
console.log('render', JSON.stringify(stats));

const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
m.on('pageerror', e => errors.push(String(e)));
await m.goto(BASE, { waitUntil: 'networkidle' }); await m.waitForSelector('body.ready');
await m.click('.modes button[data-sys="ssk"]'); await m.waitForTimeout(1500);
await m.screenshot({ path: `${OUT}/6-mobile-ssk.png` }); await m.close();

const fps = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); }; requestAnimationFrame(f); }));
console.log(JSON.stringify({ errors, fps }, null, 1));
await browser.close();
process.exit(errors.length ? 1 : 0);
