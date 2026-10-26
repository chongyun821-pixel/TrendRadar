/** Isolated UI → queued CLI → MCP preparation → mocked DOCX → registered download check. No provider calls. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const freePort = async () => {
  const socket = createServer();
  await new Promise<void>(done => socket.listen(0, '127.0.0.1', done));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>(done => socket.close(() => done()));
  return port;
};
const folder = resolve('.local/verification', `country-brief-${Date.now()}`);
mkdirSync(folder, { recursive: true });
const port = await freePort(), mcpPort = await freePort(), base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: 'test', RADAR_DATABASE: 'sqlite', RADAR_STORAGE_DIR: folder, RADAR_DB_PATH: resolve(folder, 'test.sqlite'), PORT: String(port), RADAR_APP_URL: base, RADAR_MCP_URL: `http://127.0.0.1:${mcpPort}/mcp`, CODEX_BIN: resolve('tests/fixtures/fake-brief-cli.mjs'), GROK_BIN: resolve(folder, 'unavailable-grok.exe') };
const start = (entry: string, args: string[] = []) => spawn(process.execPath, ['--import', 'tsx', entry, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
const mcp = start('mcp/server.ts', ['--http', '--port', String(mcpPort)]);
let mcpLog = '', log = '';
mcp.stdout.on('data', chunk => { mcpLog += chunk; }); mcp.stderr.on('data', chunk => { mcpLog += chunk; });
const server = start('server/node.ts');
server.stdout.on('data', chunk => { log += chunk; }); server.stderr.on('data', chunk => { log += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 100 && !log.includes(`localhost:${port}`) && server.exitCode == null; i++) await new Promise(done => setTimeout(done, 200));
  assert.ok(log.includes(`localhost:${port}`), log + mcpLog);
  browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  const receipt: unknown[] = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [], requests: any[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => { if (request.url() === `${base}/api/chat`) requests.push(request.postDataJSON()); });
    await page.addInitScript(() => localStorage.setItem('pr.model', JSON.stringify({ provider: 'gpt' })));
    await page.goto(base); await page.waitForSelector('body.ready');
    await page.evaluate(() => { (window as any).__app.setMode('sph'); (window as any).__app.focusCountry('SAU'); });
    await page.waitForFunction(() => { const globe = (window as any).__globe, point = globe.project(45, 24); return !globe.camAnim && point.x > 0 && point.x < innerWidth && point.y > 100 && point.y < innerHeight - 100 && globe.pick(point.x, point.y) === 'SAU'; });
    const point = await page.evaluate(() => (window as any).__globe.project(45, 24));
    await page.mouse.click(point.x, point.y);
    const button = page.locator('#tip.pinned .tip-brief[data-brief-country="SAU"][data-brief-system="sph"]');
    await button.waitFor();
    assert.ok(await page.locator('#tip.pinned .tip-attach').isVisible());
    await page.evaluate(() => { (document.querySelector('#q') as HTMLTextAreaElement).value = '작성 중이던 메시지'; });
    await page.screenshot({ path: resolve(folder, `button-${viewport.width}.png`) });
    if (viewport.width > 780) await button.click();
    else {
      const client = new Client({ name: 'country-brief-browser-check', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(env.RADAR_MCP_URL)));
        assert.ok((await client.listTools()).tools.some(tool => tool.name === 'create_country_brief'));
        const result = await client.callTool({ name: 'create_country_brief', arguments: { country: '사우디아라비아', system: '자주포' } });
        const applied = JSON.parse((result.content as { text: string }[])[0].text);
        assert.equal(applied.status, 'applied', JSON.stringify(applied));
      } finally { await client.close(); }
    }
    await page.locator('.downloads a').waitFor({ timeout: 30000 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'codex');
    assert.equal(requests[0].appContext.model, 'codex');
    assert.equal(requests[0].state.focus, 'SAU');
    assert.equal(requests[0].state.mode, 'sph');
    assert.match(requests[0].messages[0].text, /word-map-brief-v1/);
    assert.match(requests[0].messages[0].text, /get_country_data_status/);
    assert.equal(await page.locator('#q').inputValue(), '작성 중이던 메시지');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pr.model')!).provider), 'gpt');
    const downloading = page.waitForEvent('download');
    await page.locator('.downloads a').click();
    const download = await downloading, path = resolve(folder, `summary-${viewport.width}.docx`);
    await download.saveAs(path);
    assert.equal(readFileSync(path).subarray(0, 2).toString(), 'PK');
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(folder, `download-${viewport.width}.png`) });
    receipt.push({ viewport: viewport.width, scope: 'SAU/sph', trigger: viewport.width > 780 ? 'map button' : 'MCP create_country_brief', request: 'pass', templateAndLogo: 'prepared via MCP', download: 'pass', provider: 'mocked Codex CLI', researchAndLayout: 'simulated fixture' });
    await page.close();
  }
  writeFileSync(resolve(folder, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(`지도 Word 버튼과 모의 문서 다운로드 확인 완료: ${folder}`);
} finally { await browser?.close(); server.kill(); mcp.kill(); }
