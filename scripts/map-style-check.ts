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
    const multiplier = ({ DEU: 1, FRA: 10, ITA: 100, GBR: 1000 } as Record<string, number>)[country] || 1;
    return { id: `${country}_${system}`, country, system, src: ['stock', 'plan'],
      batches: [{ model: '검증용 장비', introYear: year - 35, qty: 100, src: ['stock'] }],
      plan: { start: year + remaining, end: year + remaining + 2, qty: [60 * multiplier, 100 * multiplier], text: '격리 일정', src: ['plan'] } };
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
  await page.route('**/api/scores?*', route => {
    const system = new URL(route.request().url()).searchParams.get('system');
    return route.fulfill({ json: { scores: fixture.records.filter(r => r.system === system).map(r => ({ country: r.country, system: r.system, score: r.country === 'DEU' ? r.system === 'mrl' ? 90 : 70 : r.system === 'sph' ? 80 : 60, grey: r.country === 'GBR', gate: r.country === 'GBR' ? '검증용 제외 사유' : null })) } });
  });
  await page.goto(base); await page.waitForSelector('body.ready');
  async function settled() { await page.waitForFunction(() => { const g = (window as any).__globe; return g.colorAnim === 1 && g.morphT === 1 && g.spikeT === 1 && !g.camAnim; }); }
  async function hover(country: string) {
    const c = fixture.countries[country];
    const p = await page.evaluate(c => (window as any).__globe.project(c.lon, c.lat), c);
    await page.mouse.move(p.x, p.y); await page.mouse.move(p.x + 0.2, p.y + 0.2);
    await page.waitForFunction(name => document.querySelector('#tip.show')?.textContent?.includes(name), c.ko);
    return page.locator('#tip').innerText();
  }
  async function surfaceMotion() {
    const result = await page.evaluate(() => {
      const g = (window as any).__globe, camera = g.camera;
      g.idle = false; g.setSelected(null); g.setHover(null);
      const position = camera.position.clone(), target = g.controls.target.clone(), quaternion = camera.quaternion.clone();
      const coordinates = [-5.5, -4.5, -3.5].flatMap(lon => [38.5, 39.5, 40.5, 41.5].map(lat => [lon, lat]));
      const gl = g.renderer.getContext(), ratio = g.renderer.getPixelRatio();
      const sample = () => {
        g.renderer.render(g.scene, camera);
        return coordinates.map(([lon, lat]) => {
          const p = g.project(lon, lat), pixel = new Uint8Array(4);
          gl.readPixels(Math.round(p.x * ratio), gl.drawingBufferHeight - Math.round(p.y * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          return pixel[0] - pixel[1];
        });
      };
      const beforePoint = g.project(-4.5, 40.5), baseline = sample(), checks: { mismatch: number; meanDifference: number; movement: number }[] = [];
      try {
        for (const delta of [0.04, 0.09, -0.07]) {
          camera.position.copy(position); g.controls.target.copy(target);
          if (g.flat) { camera.position.x += delta * 80; g.controls.target.x += delta * 80; }
          else camera.position.applyAxisAngle(camera.up, delta);
          camera.lookAt(g.controls.target); camera.updateMatrixWorld();
          const values = sample(), p = g.project(-4.5, 40.5);
          checks.push({ mismatch: values.filter((v, i) => (v > 40) !== (baseline[i] > 40)).length,
            meanDifference: values.reduce((sum, v, i) => sum + Math.abs(v - baseline[i]), 0) / values.length,
            movement: Math.hypot(p.x - beforePoint.x, p.y - beforePoint.y) });
        }
      } finally {
        camera.position.copy(position); g.controls.target.copy(target); camera.quaternion.copy(quaternion); camera.updateMatrixWorld(); g.renderer.render(g.scene, camera);
      }
      return { flat: g.flat, baseline, checks };
    });
    assert.ok(Math.max(...result.baseline) - Math.min(...result.baseline) > 30, JSON.stringify(result));
    assert.ok(result.checks.every(c => c.movement > 1 && c.mismatch <= 3 && c.meanDifference < 25), JSON.stringify(result));
    return result;
  }
  assert.equal(await page.title(), 'HORUS');
  assert.equal(await page.locator('#brandLogo').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true);
  assert.ok(await page.locator('#modes').evaluate(el => Math.abs(el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2 - innerWidth / 2) < 1));
  await page.click('.modes button[data-sys="sph"]');
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  const globeMotion = await surfaceMotion();
  const bars = await page.evaluate(() => (window as any).__globe.spikes.map((s: any) => ({ id: s.id, height: s.h1, size: s.size })));
  assert.ok(Math.max(...bars.map((b: any) => b.height)) > Math.min(...bars.map((b: any) => b.height)) * 3, JSON.stringify(bars));
  await page.screenshot({ path: resolve(folder, 'desktop-globe.png') });
  await page.click('#mapBtn'); await settled();
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
  const card = await hover('CHE');
  assert.match(card, /인접국 참고 점수/); assert.match(card, /독일/); assert.match(card, /프랑스/); assert.match(card, /확인되지 않았습니다/);
  assert.match(card, /인접국 참고/); assert.match(card, /예상 사업 합계/);
  assert.doesNotMatch(await page.locator('#legend').innerText(), /교차|상위 5개국/);
  assert.match(await page.locator('#legend').innerText(), /3년 이내 · 100%/);
  assert.match(await page.locator('#legend').innerText(), /10년 이내 · 50%/);
  assert.match(await page.locator('#legend').innerText(), /10년 이후 · 20%/);
  assert.match(await page.locator('#legend').innerText(), /원 지름/);
  await page.screenshot({ path: resolve(folder, 'desktop-flat-hatch.png') });
  const pixels = await page.evaluate(() => {
    const g = (window as any).__globe;
    const style = (id: string) => [...g.next.slice(g.byId.get(id).idx * 4, g.byId.get(id).idx * 4 + 4)];
    const styles = Object.fromEntries(['CHE', 'DEU', 'FRA', 'ITA', 'AUT', 'CZE', 'ESP', 'ISL', 'RUS'].map(id => [id, style(id)]));
    g.setSelected(null); g.setHover(null);
    g.spikeMesh.count = 0; g.renderer.render(g.scene, g.camera);
    const gl = g.renderer.getContext(), ratio = g.renderer.getPixelRatio();
    const sample = (lon: number, lat: number) => {
      const p = g.project(lon, lat), result: number[] = [];
      for (let x = -16; x <= 16; x++) {
        const pixel = new Uint8Array(4);
        gl.readPixels(Math.round(p.x * ratio) + x, gl.drawingBufferHeight - Math.round(p.y * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        result.push(pixel[0]);
      }
      return Math.max(...result) - Math.min(...result);
    };
    const hatchContrast = sample(-4.5, 40.5), solidContrast = sample(10, 51);
    const patterns = g.countries.map((c: any) => g.next[c.idx * 4 + 3]);
    return { styles, hatchContrast, solidContrast, hatchCount: patterns.filter((a: number) => a === 255).length,
      shaderErrors: g.renderer.info.programs?.filter((p: any) => p.diagnostics?.runnable === false).length ?? 0 };
  });
  assert.equal(pixels.styles.CHE[3], 255); assert.equal(pixels.styles.ESP[3], 255);
  assert.equal(pixels.styles.AUT[3], 0); assert.equal(pixels.styles.CZE[3], 0);
  assert.equal(pixels.styles.ISL[3], 0); assert.equal(pixels.styles.RUS[3], 0);
  assert.deepEqual(pixels.styles.ISL.slice(0, 3), [19, 27, 36]);
  assert.ok(pixels.hatchCount > 5 && pixels.hatchCount < 30);
  assert.deepEqual(pixels.styles.DEU.slice(0, 3), [249, 115, 22]); // 점수 제외가 지도 색을 덮어쓰지 않는다.
  assert.ok(pixels.hatchContrast > 30, JSON.stringify(pixels));
  assert.ok(pixels.solidContrast < 5, JSON.stringify(pixels));
  assert.equal(pixels.shaderErrors, 0);
  const flatMotion = await surfaceMotion();
  const circles = await page.evaluate(() => {
    const g = (window as any).__globe;
    return g.spikes.map((s: any, i: number) => {
      const a = g.spikeMesh.instanceMatrix.array, offset = i * 5 * 16;
      return { id: s.id, radius: Math.hypot(a[offset], a[offset + 1], a[offset + 2]), thickness: Math.hypot(a[offset + 4], a[offset + 5], a[offset + 6]) };
    });
  });
  assert.ok(Math.max(...circles.map((c: any) => c.radius)) > Math.min(...circles.map((c: any) => c.radius)) * 3, JSON.stringify(circles));
  assert.ok(circles.every((c: any) => Math.abs(c.thickness - 0.12) < 0.01), JSON.stringify(circles));
  assert.match(await hover('AUT'), /자료 일부/);
  assert.match(await hover('CZE'), /자료 일부 · 시기 미확인/);
  await page.evaluate(() => {
    const g = (window as any).__globe;
    const x = Math.PI * 100 + 15;
    g.camera.position.set(x, 0, 270); g.controls.target.set(x, 0, 100); g.camera.lookAt(g.controls.target);
  });
  await page.waitForFunction(() => Math.abs((window as any).__globe.controls.target.x) <= Math.PI * 100);
  const wrapped = await page.evaluate(() => {
    const g = (window as any).__globe, p = g.project(134, -25);
    return { country: g.pick(p.x, p.y), copies: g.worldCopies.filter((c: any) => c.visible).length, x: g.controls.target.x };
  });
  assert.equal(wrapped.country, 'AUS'); assert.equal(wrapped.copies, 4);
  await page.screenshot({ path: resolve(folder, 'desktop-dateline.png') });
  await page.evaluate(() => {
    const g = (window as any).__globe;
    g.camera.position.z = 100 + g.flatMaxDistance() * 3; g.camera.position.y = 999; g.controls.target.y = 999;
  });
  await page.waitForFunction(() => {
    const g = (window as any).__globe;
    return g.camera.position.z - 100 <= g.flatMaxDistance() + 0.01 && Math.abs(g.controls.target.y) < 0.01;
  });
  const polarLimit = await page.evaluate(() => {
    const g = (window as any).__globe;
    return { distance: g.camera.position.z - 100, max: g.flatMaxDistance(), y: g.controls.target.y };
  });
  await page.evaluate(() => (window as any).__app.focusCountry('CHE')); await settled();
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
  await page.waitForFunction(() => {
    const g = (window as any).__globe, idx = g.byId.get('DEU').idx * 4;
    return g.colorAnim === 1 && g.next[idx] === 236;
  });
  assert.match(await page.locator('#legend').innerText(), /수주 판단 점수 최고 무기/);
  const general = await page.evaluate(() => {
    const g = (window as any).__globe;
    return Object.fromEntries(['DEU', 'FRA', 'GBR'].map(id => { const i = g.byId.get(id).idx * 4; return [id, [...g.next.slice(i, i + 4)]]; }));
  });
  assert.deepEqual(general.DEU, [236, 72, 153, 0]); assert.deepEqual(general.FRA, [125, 58, 11, 0]); assert.deepEqual(general.GBR, [19, 27, 36, 0]);
  assert.equal(await page.evaluate(() => { const a = (window as any).__globe.next; return [...a].filter((_, i) => i % 4 === 3).some(v => v !== 0); }), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => (window as any).__app.focusCountry('DEU')); await settled();
  assert.match(await hover('DEU'), /다연장로켓 · 판단 90\/100/);
  await page.screenshot({ path: resolve(folder, 'desktop-general.png') });
  assert.equal(providerCalls, 0); assert.deepEqual(errors, []);
  writeFileSync(resolve(folder, 'receipt.json'), JSON.stringify({ passed: true, pixels, globeMotion, flatMotion, bars, circles, wrapped, polarLimit, general, layout, providerCalls, errors, hues: SYSTEM_COLOR }, null, 2));
  console.log(JSON.stringify({ passed: true, folder, hatchContrast: pixels.hatchContrast, solidContrast: pixels.solidContrast, providerCalls, errors }));
} finally {
  writeFileSync(resolve(folder, 'server.log'), log);
  await browser?.close(); server.kill();
}
