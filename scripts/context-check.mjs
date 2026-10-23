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
async function tool(name, args = {}, context, allowError = false) {
  context ||= await state();
  const response = await page.request.post(`${base}/api/tools/${name}`, { data: { args, conversationId: context.conversationId, appContext: context } });
  assert.equal(response.status(), 200);
  const data = await response.json(); assert.ok(allowError || !data.result?.error, JSON.stringify(data.result)); return data.result;
}
async function finished() { await page.waitForFunction(() => document.querySelector('#chatStatus').textContent === '완료'); }
try {
  const toolResponse = await page.request.post(`${base}/api/tools/get_report_template`, { data: { args: { format: 'pptx' } } });
  const toolSession = await toolResponse.json(); assert.equal(toolResponse.status(), 200); ids.push(toolSession.conversationId);
  await page.goto(base); await page.waitForSelector('body.ready');
  await page.fill('#q', '/sessions'); await page.press('#q', 'Enter');
  await page.locator(`#picker .picker-item[data-id="${toolSession.conversationId}"]`).click();
  await page.waitForFunction(id => window.__app.getAppContext().conversationId === id, toolSession.conversationId);
  await page.waitForFunction(() => document.querySelector('.panel').getBoundingClientRect().height > 60);
  assert.equal(await page.locator('.conversation-empty strong').textContent(), 'MCP 도구 실행');
  await page.fill('#q', '/sessions'); await page.press('#q', 'Enter');
  assert.equal(await page.locator(`#picker .picker-item.current[data-id="${toolSession.conversationId}"]`).count(), 1);
  await page.press('#q', 'Escape');
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
  const command = await tool('set_map_state', { country: '캐나다', system: '호위함', flat: true });
  assert.equal(command.status, 'applied', JSON.stringify(command));
  // applied는 브라우저가 적용을 마친 뒤 돌려준다
  assert.ok(await page.evaluate(() => window.__app.state.focus === 'CAN' && window.__app.state.mode === 'frigate' && window.__app.state.flat));

  // 사용자가 화면을 바꾼 뒤에도 챗봇 명령은 그대로 적용된다(버전·충돌 없음)
  await page.evaluate(() => window.__app.focusCountry('AUS'));
  const later = await tool('set_map_state', { country: 'POL' });
  assert.equal(later.status, 'applied', JSON.stringify(later)); assert.equal((await state()).focus, 'POL');

  assert.equal((await tool('set_chat_model', { model: 'nemotron' })).status, 'applied');
  await page.waitForFunction(() => document.querySelector('#modelLabel').textContent === '네모트론');
  const created = await tool('create_conversation', { title: '격리 화면 제어 검증' }); ids.push(created.id);
  const switched = await tool('switch_conversation', { conversationId: created.id });
  assert.equal(switched.status, 'applied', JSON.stringify(switched));
  await page.waitForFunction(id => localStorage.getItem('pr.conversation') === id, created.id);
  assert.equal((await state()).conversationId, created.id);
  assert.equal((await state()).report, null);
  await page.waitForFunction(() => document.querySelector('.panel').getBoundingClientRect().height > 60);
  await page.evaluate(() => { window.__app.setMode(null); window.__app.focusCountry('SAU'); });
  await page.waitForFunction(() => { const point = window.__globe.project(45, 24); return point.x > 0 && point.x < innerWidth && point.y > 100 && point.y < innerHeight - 100 && window.__globe.pick(point.x, point.y) === 'SAU'; });
  let point = await page.evaluate(() => window.__globe.project(45, 24));
  await page.mouse.click(point.x, point.y);
  // 보고서 칩: 채팅 요청 없이 보고서를 띄우고 다음 메시지 첨부로 쌓는다
  const chatCount = captures.length;
  await page.locator('#tip.pinned button[data-report-country="SAU"][data-report-system="ifv"]').click();
  await page.waitForFunction(() => window.__app.getAppContext().report?.system === 'ifv' && document.querySelectorAll('#attachments .chip').length === 1);
  assert.equal(captures.length, chatCount, '보고서 클릭이 채팅 요청을 보냄');
  assert.equal(await page.locator('.m.user').count(), 0);
  assert.equal(await page.locator('.m.report').count(), 1);
  assert.match(await page.textContent('#attachments'), /사우디아라비아 보병전투차 보고서|사우디아라비아 .+ 보고서/);
  assert.equal((await state()).mode, 'ifv'); assert.equal((await state()).report.country, 'SAU'); assert.equal((await state()).report.system, 'ifv');
  assert.equal(await page.locator('#modes button[data-sys="ifv"]').getAttribute('class'), 'on');
  await page.screenshot({ path: join(folder, 'saudi-report-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.locator('#chat').evaluate(element => element.classList.contains('open'))) await page.click('#chatToggle');
  await page.evaluate(() => { window.__app.setMode(null); window.__app.focusCountry('SAU'); });
  await page.waitForFunction(() => { const point = window.__globe.project(45, 24); return !window.__globe.camAnim && point.x > 0 && point.x < innerWidth && point.y > 100 && point.y < innerHeight - 100 && window.__globe.pick(point.x, point.y) === 'SAU'; });
  point = await page.evaluate(() => window.__globe.project(45, 24)); await page.mouse.click(point.x, point.y);
  await page.locator('#tip.pinned button[data-report-country="SAU"][data-report-system="sam"]').click();
  await page.waitForFunction(() => window.__app.getAppContext().report?.system === 'sam' && document.querySelectorAll('#attachments .chip').length === 2);
  assert.equal(captures.length, chatCount, '보고서 클릭이 채팅 요청을 보냄');
  assert.equal((await state()).mode, 'sam'); assert.equal((await state()).report.system, 'sam');
  const samReport = (await state()).report.id;
  // 첨부 칩은 눌러 뺄 수 있고, 남은 보고서는 다음 메시지와 함께 간다
  await page.locator('#attachments .chip').first().click();
  assert.equal(await page.locator('#attachments .chip').count(), 1);
  await page.fill('#q', '!help'); await page.press('#q', 'Enter'); await finished();
  assert.deepEqual(captures.at(-1).reportIds, [samReport]);
  assert.equal(captures.at(-1).appContext.report.id, samReport);
  assert.match(captures.at(-1).messages[0].text, /첨부: 사우디아라비아 .+ 보고서$/);
  assert.equal(await page.locator('#attachments .chip').count(), 0);
  await page.reload(); await page.waitForSelector('body.ready');
  await page.waitForFunction(() => document.querySelectorAll('.m.report').length === 2);
  assert.equal(await page.locator('#attachments .chip').count(), 0);
  await page.waitForFunction(() => { const panel = document.querySelector('.panel'); return getComputedStyle(panel).opacity === '1' && panel.getAnimations().every(animation => animation.playState === 'finished'); });
  await page.screenshot({ path: join(folder, 'mobile.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(folder, 'desktop.png') });
  assert.deepEqual(errors, []);
  const receipt = { emptyToolConversation: 'pass', continueToolConversation: 'pass', screenContext: 'pass', reportSelection: 'pass', requestSnapshot: 'pass', viewedReport: 'pass', mapCommand: 'pass', commandAfterUserChange: 'pass', modelSelection: 'pass', conversationSwitch: 'pass', saudiReportDesktop: 'pass', saudiReportMobile: 'pass', reportClickNoChat: 'pass', reportAttachment: 'pass', mobile: 'pass', errors, switched: switched.status };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, folder }));
} finally {
  for (const id of ids) if (id) await page.request.delete(`${base}/api/conversations/${id}`).catch(() => {});
  await browser.close();
}
