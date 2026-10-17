import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 격리된 테스트 서버에서만 실행한다. 모델 서비스는 호출하지 않는다.
const base = process.env.BASE_URL || 'http://localhost:62401';
const options = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (process.env.CHROME_PATH) options.executablePath = process.env.CHROME_PATH; else options.channel = 'chrome';
const browser = await chromium.launch(options), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const ids = [], errors = [], captures = [];
const folder = join('.local/verification', `app-context-${Date.now()}`); mkdirSync(folder, { recursive: true });
page.on('pageerror', error => errors.push(String(error)));
page.on('request', request => { if (request.url() === `${base}/api/chat`) captures.push(request.postDataJSON()); });
const state = () => page.evaluate(() => window.__app.getAppContext());
async function tool(name, args = {}, context) {
  context ||= await state();
  const response = await page.request.post(`${base}/api/tools/${name}`, { data: { args, conversationId: context.conversationId, appContext: context } });
  assert.equal(response.status(), 200);
  const data = await response.json(); assert.ok(!data.result?.error, JSON.stringify(data.result)); return data.result;
}
async function finished() { await page.waitForFunction(() => document.querySelector('#chatStatus').textContent === '완료'); }
async function commandResult(id, status) {
  for (let i = 0; i < 30; i++) {
    const result = await tool('get_app_command', { commandId: id });
    if (result.status === status) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`명령 ${id}: ${status} 확인 실패`);
}
try {
  const toolResponse = await page.request.post(`${base}/api/tools/get_report_template`, { data: { args: { format: 'pptx' } } });
  const toolSession = await toolResponse.json(); assert.equal(toolResponse.status(), 200); ids.push(toolSession.conversationId);
  await page.goto(base); await page.waitForSelector('body.ready');
  await page.click('#historyToggle');
  await page.locator(`button[data-conversation-id="${toolSession.conversationId}"]`).click();
  await page.waitForFunction(id => window.__app.getAppContext().conversationId === id, toolSession.conversationId);
  await page.waitForFunction(() => document.querySelector('.panel').getBoundingClientRect().height > 60);
  assert.equal(await page.locator('.conversation-empty strong').textContent(), 'MCP 도구 실행');
  assert.equal(await page.locator(`button[data-conversation-id="${toolSession.conversationId}"]`).getAttribute('aria-pressed'), 'true');
  await page.fill('#q', '!help'); await page.press('#q', 'Enter'); await finished();
  assert.equal(captures.at(-1).conversationId, toolSession.conversationId);
  assert.equal(await page.locator('.conversation-empty').count(), 0);
  await page.evaluate(() => { window.__app.setMode('sph'); window.__app.focusCountry('POL'); });
  await page.fill('#q', '!보고서 폴란드 자주포'); await page.press('#q', 'Enter'); await finished();
  ids.push(await page.evaluate(() => localStorage.getItem('pr.conversation')));
  await page.waitForFunction(() => window.__app.getAppContext().activeView === 'report');
  assert.equal((await state()).report.country, 'POL');
  const firstReport = (await state()).report.id;
  await page.fill('#q', '!보고서 폴란드 자주포'); await page.press('#q', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.m.report').length === 2 && document.querySelector('#chatStatus').textContent === '완료');
  assert.notEqual((await state()).report.id, firstReport);
  await page.evaluate(() => { window.__app.setMode('ifv'); window.__app.focusCountry('FIN'); });
  await page.locator('.m.report').first().click({ position: { x: 30, y: 30 } });
  const reportContext = await state();
  assert.equal(reportContext.focus, 'FIN'); assert.equal(reportContext.mode, 'ifv');
  assert.equal(reportContext.report.country, 'POL'); assert.equal(reportContext.activeView, 'report');
  assert.equal(reportContext.report.id, firstReport);
  await page.fill('#q', '!help'); await page.press('#q', 'Enter'); await finished();
  assert.equal(captures.at(-1).appContext.report.country, 'POL');
  assert.equal(captures.at(-1).appContext.focus, 'FIN');
  const packet = await tool('prepare_report'); assert.equal(packet.basis, 'viewed'); assert.equal(packet.country, 'POL');
  const command = await tool('set_map_state', { payload: JSON.stringify({ country: 'CAN', system: 'frigate', flat: true }) });
  assert.equal(command.status, 'pending');
  await page.waitForFunction(() => window.__app.state.focus === 'CAN' && window.__app.state.mode === 'frigate' && window.__app.state.flat);
  await commandResult(command.commandId, 'applied');

  let release, seen;
  const gate = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { seen = resolve; });
  await page.route('**/api/app-context/*/commands', async route => {
    const response = await route.fetch(), data = await response.json();
    if (data.length) { seen(); await gate; }
    await route.fulfill({ response, json: data });
  });
  const stale = await tool('set_map_state', { payload: '{"country":"POL"}' });
  await ready;
  await page.evaluate(() => window.__app.focusCountry('AUS')); release();
  await commandResult(stale.commandId, 'conflict');
  assert.equal((await state()).focus, 'AUS');
  await page.unroute('**/api/app-context/*/commands');

  await tool('set_chat_model', { model: 'nemotron' });
  await page.waitForFunction(() => document.querySelector('#model').value === 'nemotron');
  const created = await tool('create_conversation', { title: '격리 화면 제어 검증' }); ids.push(created.id);
  const switched = await tool('switch_conversation', { conversationId: created.id });
  await page.waitForFunction(id => localStorage.getItem('pr.conversation') === id, created.id);
  assert.equal((await state()).conversationId, created.id);
  assert.equal((await state()).report, null);
  await page.waitForFunction(() => document.querySelector('.panel').getBoundingClientRect().height > 60);
  await page.evaluate(() => { window.__app.setMode(null); window.__app.focusCountry('SAU'); });
  await page.waitForFunction(() => { const point = window.__globe.project(45, 24); return point.x > 0 && point.x < innerWidth && point.y > 100 && point.y < innerHeight - 100 && window.__globe.pick(point.x, point.y) === 'SAU'; });
  let point = await page.evaluate(() => window.__globe.project(45, 24));
  await page.mouse.click(point.x, point.y);
  await page.locator('#tip.pinned button[data-report-country="SAU"][data-report-system="ifv"]').click();
  await finished();
  assert.equal((await state()).mode, 'ifv'); assert.equal((await state()).report.country, 'SAU'); assert.equal((await state()).report.system, 'ifv');
  assert.equal(await page.locator('#modes button[data-sys="ifv"]').getAttribute('class'), 'on');
  await page.screenshot({ path: join(folder, 'saudi-report-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#chat').evaluate(element => element.classList.contains('open'))) await page.click('#chatToggle');
  await page.evaluate(() => { window.__app.setMode(null); window.__app.focusCountry('SAU'); });
  await page.waitForFunction(() => { const point = window.__globe.project(45, 24); return !window.__globe.camAnim && point.x > 0 && point.x < innerWidth && point.y > 100 && point.y < innerHeight - 100 && window.__globe.pick(point.x, point.y) === 'SAU'; });
  point = await page.evaluate(() => window.__globe.project(45, 24)); await page.mouse.click(point.x, point.y);
  await page.locator('#tip.pinned button[data-report-country="SAU"][data-report-system="sam"]').click(); await finished();
  assert.equal((await state()).mode, 'sam'); assert.equal((await state()).report.system, 'sam');
  await page.waitForFunction(() => { const panel = document.querySelector('.panel'); return getComputedStyle(panel).opacity === '1' && panel.getAnimations().every(animation => animation.playState === 'finished'); });
  await page.screenshot({ path: join(folder, 'mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(folder, 'desktop.png') });
  assert.deepEqual(errors, []);
  const receipt = { emptyToolConversation: 'pass', continueToolConversation: 'pass', screenContext: 'pass', reportSelection: 'pass', requestSnapshot: 'pass', viewedReport: 'pass', mapCommand: 'pass', staleCommand: 'pass', modelSelection: 'pass', conversationSwitch: 'pass', saudiReportDesktop: 'pass', saudiReportMobile: 'pass', mobile: 'pass', errors, switchedCommand: switched.commandId };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, folder }));
} finally {
  for (const id of ids) if (id) await page.request.delete(`${base}/api/conversations/${id}`).catch(() => {});
  await browser.close();
}
