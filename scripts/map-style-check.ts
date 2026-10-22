/** 빌드된 UI를 별도 SQLite 서버와 가상 자료로 검증한다. 운영 DB·모델은 호출하지 않는다. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { SYSTEM_COLOR } from '../src/map-style';
import type { ProgramRecord, Seed } from '../shared/types';

const folder = resolve('.local/verification', `map-style-${Date.now()}`);
mkdirSync(folder, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'server/node.ts'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', RADAR_DATABASE: 'sqlite', RADAR_STORAGE_DIR: folder, RADAR_DB_PATH: resolve(folder, 'test.sqlite'), PORT: '0' },
});
let log = '';
server.stdout.on('data', b => { log += b; });
server.stderr.on('data', b => { log += b; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 100 && !/http:\/\/localhost:\d+/.test(log) && server.exitCode == null; i++) await new Promise(r => setTimeout(r, 200));
  const port = log.match(/http:\/\/localhost:(\d+)/)?.[1];
  assert.ok(port, '격리 서버 시작 실패');
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await (await fetch(`${base}/api/health`)).json()).storage, 'sqlite');
  const fixture: Seed = await (await fetch(`${base}/api/data`)).json();
  const catalog = JSON.parse(readFileSync('shared/country-catalog.json', 'utf8'));
  fixture.countries = Object.fromEntries(catalog.map((c: { id: string }) => [c.id, c]));
  const year = fixture.meta.baseYear; // 기준 연도는 meta.baseYear 하나(shared/base-year.ts)
  fixture.sources = {
    stock: { t: '격리 장비 자료', u: 'https://example.com/stock', y: year },
    plan: { t: '격리 사업 일정', u: 'https://example.com/plan', y: year },
  };
  function record(country: string, remaining: number, system: 'sph' | 'mrl' = 'sph'): ProgramRecord {
    return { id: `${country}_${system}`, country, system, src: ['stock', 'plan'],
      batches: [{ model: '검증용 장비', introYear: year - 35, qty: 100, src: ['stock'] }],
      plan: { start: year + remaining, end: year + remaining + 2, qty: [60, 100], text: '격리 일정', src: ['plan'] } };
  }
  const partial = record('AUT', 0); partial.batches[0].qty = null; partial.plan!.qty = null;
  const unknown = record('CZE', 0); unknown.batches[0].introYear = null; delete unknown.plan;
  fixture.records = [record('DEU', 0), record('FRA', 4), record('ITA', 8), record('GBR', 16), partial, unknown, record('FRA', 0, 'mrl'), record('DEU', 0, 'mrl')];
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => { (window as any).__name = (fn: unknown) => fn; }); // tsx의 함수 이름 도우미
  const errors: string[] = [];
  let providerCalls = 0;
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', r => { if (r.url().endsWith('/api/chat')) providerCalls++; });
  await page.route('**/api/data', route => route.fulfill({ json: fixture, headers: { 'x-data-version': '1' } }));
  await page.route('**/api/data/version', route => route.fulfill({ json: { revision: 1 } }));
  await page.route('**/api/scores?*', route => route.fulfill({ json: { scores: fixture.records.map(r => ({ country: r.country, score: 0, grey: true, gate: '검증용 제외 사유' })) } }));
  await page.goto(base); await page.waitForSelector('body.ready');
  async function settled() { await page.waitForFunction(() => { const g = (window as any).__globe; return g.colorAnim === 1 && g.morphT === 1 && g.spikeT === 1 && !g.camAnim; }); }
  async function hover(country: string) {
    const c = fixture.countries[country];
    const p = await page.evaluate(c => (window as any).__globe.project(c.lon, c.lat), c);
    await page.mouse.move(p.x, p.y); await page.mouse.move(p.x + 0.2, p.y + 0.2);
    await page.waitForFunction(name => document.querySelector('#tip.show')?.textContent?.includes(name), c.ko);
    return page.locator('#tip').innerText();
  }
  await page.click('.modes button[data-sys="sph"]');
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  await page.screenshot({ path: resolve(folder, 'desktop-globe.png') });
  await page.click('#mapBtn'); await settled();
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  const card = await hover('CHE');
  assert.match(card, /인접국 참고/); assert.match(card, /독일/); assert.match(card, /프랑스/); assert.match(card, /확인되지 않았습니다/);
  await page.screenshot({ path: resolve(folder, 'desktop-flat-hatch.png') });
  const pixels = await page.evaluate(() => {
    const g = (window as any).__globe;
    const style = (id: string) => [...g.next.slice(g.byId.get(id).idx * 4, g.byId.get(id).idx * 4 + 4)];
    const styles = Object.fromEntries(['CHE', 'DEU', 'FRA', 'ITA', 'AUT', 'CZE', 'ESP'].map(id => [id, style(id)]));
    g.setSelected(null); g.setHover(null); g.setSpikes([]);
    // 실제 셰이더가 스위스 안에만 빗금을 그리고 독일 안은 단색으로 유지하는지 검사한다.
    g.spikeMesh.count = 0; g.renderer.render(g.scene, g.camera);
    const gl = g.renderer.getContext(), ratio = g.renderer.getPixelRatio();
    const sample = (lon: number, lat: number) => {
      const p = g.project(lon, lat), result: number[] = [];
      for (let x = -4; x <= 4; x++) {
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.round(p.x * ratio) + x, gl.drawingBufferHeight - Math.round(p.y * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        result.push(pixel[0]);
      }
      return Math.max(...result) - Math.min(...result);
    };
    return { styles, hatchContrast: sample(7.9, 46.8), solidContrast: sample(10, 51), shaderErrors: g.renderer.info.programs?.filter((p: any) => p.diagnostics?.runnable === false).length ?? 0 };
  });
  assert.equal(pixels.styles.CHE[3], 255); assert.equal(pixels.styles.ESP[3], 0);
  assert.equal(pixels.styles.AUT[3], 0); assert.equal(pixels.styles.CZE[3], 0);
  assert.deepEqual(pixels.styles.DEU.slice(0, 3), [249, 115, 22]); // 점수 제외가 지도 색을 덮어쓰지 않는다.
  assert.ok(pixels.hatchContrast > 30, JSON.stringify(pixels));
  assert.ok(pixels.solidContrast < 5, JSON.stringify(pixels));
  assert.equal(pixels.shaderErrors, 0);
  assert.match(await hover('AUT'), /연한 색 · 자료 일부/);
  assert.match(await hover('CZE'), /연한 회색 · 시기 미확인/);
  await page.click('.modes button[data-sys="mrl"]'); await settled();
  assert.match(await page.locator('#legend').innerText(), /다연장로켓/);
  assert.equal(await page.locator('.legend-title i').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(236, 72, 153)');
  assert.ok(await page.evaluate(hue => (window as any).__globe.spikes.every((s: any) => s.color === hue), SYSTEM_COLOR.mrl));
  await page.screenshot({ path: resolve(folder, 'desktop-mrl.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  await hover('CHE');
  const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, legend: document.querySelector('#legend')!.getBoundingClientRect().toJSON(), composer: document.querySelector('.bar')!.getBoundingClientRect().toJSON(), tip: document.querySelector('#tip')!.getBoundingClientRect().toJSON() }));
  assert.ok(layout.width <= layout.viewport); assert.ok(layout.legend.right <= layout.viewport);
  assert.ok(layout.legend.bottom <= layout.composer.top, JSON.stringify(layout));
  assert.ok(layout.tip.bottom <= layout.legend.top || layout.tip.top >= layout.legend.bottom, JSON.stringify(layout));
  await page.screenshot({ path: resolve(folder, 'mobile-flat.png') });
  await page.click('#mapBtn'); await settled();
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  await page.screenshot({ path: resolve(folder, 'mobile-globe.png') });
  await page.evaluate(() => (window as any).__app.setMode(null)); await settled();
  assert.equal(await page.locator('#legend').evaluate(el => el.classList.contains('show')), false);
  assert.equal(await page.evaluate(() => { const a = (window as any).__globe.next; return [...a].filter((_, i) => i % 4 === 3).some(v => v !== 0); }), false);
  assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  writeFileSync(resolve(folder, 'receipt.json'), JSON.stringify({ passed: true, pixels, layout, providerCalls, errors, hues: SYSTEM_COLOR }, null, 2));
  console.log(JSON.stringify({ passed: true, folder, hatchContrast: pixels.hatchContrast, solidContrast: pixels.solidContrast, providerCalls, errors }));
} finally {
  writeFileSync(resolve(folder, 'server.log'), log);
  await browser?.close(); server.kill();
}
