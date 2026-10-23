import { chromium, type Route } from 'playwright-core';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { repository, now } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut } from '../server/agent';
import { saveAppContext } from '../server/app-context';
import type { AppContext } from '../shared/app-context';

// 실행 중인 격리 SQLite 서버와 같은 저장 경로를 지정한다. 모델과 운영 DB는 호출하지 않는다.
assert.equal(process.env.RADAR_DATABASE, 'sqlite');
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.RADAR_DB_PATH);
const base = process.env.BASE_URL || 'http://localhost:62401';
assert.equal((await (await fetch(`${base}/api/health`)).json()).storage, 'sqlite');
const repo = repository(), conversation = await repo.createConversation('화면 연속 제어 검증'), runId = randomUUID();
await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', runId, conversation.id, 'test-screen', 'running', now(), process.pid);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [], folder = join('.local/verification', `screen-control-${Date.now()}`);
mkdirSync(folder, { recursive: true });
page.on('pageerror', error => errors.push(String(error)));
const state = (): Promise<AppContext> => page.evaluate(() => (window as any).__app.getAppContext());
let requestContext: AppContext;
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return executions.run({ repo, runId, conversationId: conversation.id, appContext: requestContext, signal: new AbortController().signal, env: {} }, () => runTool(name, args, newOut()));
}
/** 화면 도구는 적용 결과를 바로 돌려준다. 명령을 붙잡아 둔 경우(pending·inactive)만 get_app_command로 이어서 확인한다 */
async function confirmed(command: any, status = 'applied') {
  if (command.status === status) return;
  assert.ok(['pending', 'inactive'].includes(command.status), JSON.stringify(command));
  for (let i = 0; i < 4; i++) {
    const result = await tool('get_app_command', { commandId: command.commandId });
    if (result.status !== 'pending') { assert.equal(result.status, status, JSON.stringify(result)); return; }
  }
  throw new Error(`명령 적용 확인 시간 초과: ${command.commandId}`);
}
async function holdCommands() {
  let release!: () => void, seen!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { seen = resolve; });
  const handler = async (route: Route) => {
    const response = await route.fetch(), data = await response.json();
    if (data.length) { seen(); await gate; }
    await route.fulfill({ response, json: data });
  };
  await page.route('**/api/app-context/*/commands', handler);
  return { ready, release, close: () => page.unroute('**/api/app-context/*/commands', handler) };
}
try {
  await page.addInitScript(id => localStorage.setItem('pr.conversation', id), conversation.id);
  await page.goto(base); await page.waitForSelector('body.ready');
  await page.waitForFunction(id => (window as any).__app.getAppContext().conversationId === id, conversation.id);
  requestContext = await state(); await saveAppContext(repo, requestContext);
  await repo.event(runId, 'app.context', requestContext);

  // 기다림 없이 바로 applied: 한국어 이름을 일반 필드로 받는다
  const initial = await tool('set_map_state', { system: '다연장로켓' }); assert.equal(initial.status, 'applied', JSON.stringify(initial));
  const pol = await tool('set_map_state', { country: '폴란드' }); assert.equal(pol.status, 'applied', JSON.stringify(pol));
  assert.equal((await state()).mode, 'mrl'); assert.equal((await state()).focus, 'POL');
  const report = await tool('write_report', { country: '폴란드', system: '다연장로켓' });
  assert.equal(report.status, 'applied'); assert.equal(report.shown, true);
  let current = await state();
  assert.equal(current.activeView, 'report'); assert.equal(current.report?.id, report.reportId);
  assert.equal(current.report?.country, 'POL'); assert.equal(current.report?.system, 'mrl');
  assert.equal(await page.locator(`[data-report-id="${report.reportId}"] h3`).count(), 6);
  assert.equal((await repo.runStatus(runId)).status, 'running');
  await page.waitForFunction(() => !(window as any).__globe.camAnim);
  await page.screenshot({ path: join(folder, 'poland-mrl-report-desktop.png') });

  // 같은 버전으로 접수된 두 명령은 한 번에 도착하거나 서로 다른 주기에 도착해도 이어서 적용한다.
  let held = await holdCommands();
  const mode = await tool('set_map_state', { system: '대공미사일' });
  const focus = await tool('set_map_state', { country: '핀란드' });
  held.release(); await confirmed(mode); await confirmed(focus); await held.close();
  assert.equal((await state()).mode, 'sam'); assert.equal((await state()).focus, 'FIN');

  // 적용 확인 전송이 실패해도 명령을 다시 실행하지 않고 결과만 재전송한다.
  let failedAcknowledgements = 0;
  await page.route('**/api/app-context/*/commands/*', async route => {
    if (!failedAcknowledgements++) await route.abort(); else await route.continue();
  });
  await confirmed(await tool('set_map_state', { flat: true }));
  assert.equal((await state()).flat, true);
  assert.ok(failedAcknowledgements >= 2);
  await page.unroute('**/api/app-context/*/commands/*');
  await confirmed(await tool('set_map_state', { flat: '3D' }));
  assert.equal((await state()).flat, false);

  // 사용자가 그사이 화면을 바꿨어도 챗봇의 화면 명령은 적용된다(예전 expectedVersion도 막지 않는다).
  held = await holdCommands();
  const before = await state();
  const first = await tool('set_map_state', { system: '장갑차' });
  const pinned = await tool('set_map_state', { country: 'CAN', expectedVersion: before.version });
  held.release(); await confirmed(first); await confirmed(pinned); await held.close();
  assert.equal((await state()).focus, 'CAN');

  held = await holdCommands();
  const afterUser = await tool('set_map_state', { country: '폴란드' });
  await held.ready; await page.evaluate(() => (window as any).__app.focusCountry('AUS')); held.release();
  await confirmed(afterUser); await held.close();
  assert.equal((await state()).focus, 'POL');
  await page.evaluate(() => (window as any).__app.focusCountry('AUS'));
  await saveAppContext(repo, await state());
  const korea = await tool('set_map_state', { country: '한국' });
  assert.equal(korea.status, 'applied', JSON.stringify(korea)); assert.equal((await state()).focus, 'KOR');
  await page.evaluate(() => (window as any).__app.focusCountry('AUS'));

  // 확대·축소, 2D/3D, 국가 숨김·특정 국가만·강조, 빗금·막대·범례 표시
  const camDist = () => page.evaluate(() => { const g = (window as any).__globe; return g.flat ? g.camera.position.z - 100 : g.camera.position.length() - 100; });
  const settle = () => page.waitForFunction(() => { const g = (window as any).__globe; return !g.camAnim && g.morphT >= 1; });
  await settle();
  const far = await camDist();
  assert.equal((await tool('set_map_state', { zoom: 'in' })).status, 'applied'); await settle();
  assert.ok(await camDist() < far * 0.7, `확대 ${far} → ${await camDist()}`);
  assert.equal((await tool('set_map_state', { zoom: 1 })).status, 'applied'); await settle();
  assert.ok(await camDist() > 600);
  assert.equal((await tool('set_map_state', { country: '폴란드', system: '자주포', zoom: 8 })).status, 'applied'); await settle();
  assert.equal((await state()).focus, 'POL'); assert.ok(await camDist() < 80);
  const shown = await tool('set_map_state', { highlight: '폴란드, 루마니아', hide: '러시아', hatch: false });
  assert.equal(shown.status, 'applied', JSON.stringify(shown));
  let display = (await state()).display!;
  assert.deepEqual(display.highlight, ['POL', 'ROU']); assert.deepEqual(display.hidden, ['RUS']); assert.equal(display.hatch, false);
  assert.match(await page.locator('#legend .display-note').innerText(), /숨김 .*강조 .*빗금 끔/);
  await page.waitForFunction(() => (window as any).__globe.colorAnim >= 1 && (window as any).__globe.spikeT >= 1); await page.screenshot({ path: join(folder, 'highlight-hide-nohatch.png') });
  assert.equal((await tool('set_map_state', { flat: true, only: '폴란드, 독일, 체코', zoom: 'reset' })).status, 'applied'); await settle();
  display = (await state()).display!;
  assert.deepEqual(display.only, ['POL', 'DEU', 'CZE']); assert.equal((await state()).flat, true);
  const spikes = await page.evaluate(() => (window as any).__globe.spikes.filter((s: any) => s.h1 > 0).map((s: any) => s.id));
  assert.ok(spikes.length && spikes.every((id: string) => ['POL', 'DEU', 'CZE'].includes(id)), JSON.stringify(spikes));
  await page.waitForFunction(() => (window as any).__globe.colorAnim >= 1 && (window as any).__globe.spikeT >= 1); await page.screenshot({ path: join(folder, 'only-2d.png') });
  assert.equal((await tool('set_map_state', { legend: false, bars: false })).status, 'applied');
  assert.equal(await page.locator('#legend.show').count(), 0);
  assert.equal(await page.evaluate(() => (window as any).__globe.spikes.filter((s: any) => s.h1 > 0).length), 0);
  assert.equal((await tool('set_map_state', { resetDisplay: true, flat: false, zoom: 'reset' })).status, 'applied'); await settle();
  assert.deepEqual((await state()).display, { hidden: [], only: null, highlight: [], hatch: true, bars: true, legend: true });
  assert.equal(await page.locator('#legend.show').count(), 1);
  assert.equal((await tool('set_map_state', { zoom: '20' })).status, 'failed');
  await page.evaluate(() => (window as any).__app.focusCountry('AUS'));

  // 사용자가 새로 요청한 상황을 재현하고 모바일에서도 같은 도구로 보고서를 연다.
  requestContext = await state(); await saveAppContext(repo, requestContext);
  // 탭이 백그라운드면 inactive와 안내를 바로 받고, 탭이 다시 보이면 남은 명령이 적용된다
  const setHidden = (hidden: boolean) => page.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: ${hidden} }); document.dispatchEvent(new Event('visibilitychange'))`);
  await setHidden(true);
  await page.waitForTimeout(300);
  const background = await tool('set_map_state', { country: '일본' });
  assert.equal(background.status, 'inactive', JSON.stringify(background)); assert.match(background.message, /백그라운드/);
  assert.equal((await state()).focus, 'AUS');
  await setHidden(false);
  await confirmed(background);
  assert.equal((await state()).focus, 'JPN');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await tool('write_report', { country: '폴란드', system: '다연장로켓' });
  assert.equal(mobile.status, 'applied');
  current = await state(); assert.equal(current.report?.id, mobile.reportId);
  assert.equal(current.focus, 'POL'); assert.equal(current.mode, 'mrl'); assert.equal(current.activeView, 'report');
  assert.equal(await page.locator('#modes button.on').getAttribute('data-sys'), 'mrl');
  await page.waitForFunction(() => !(window as any).__globe.camAnim && document.querySelector('#modes')!.getAnimations({ subtree: true }).every(a => a.playState === 'finished'));
  await page.screenshot({ path: join(folder, 'poland-mrl-report-mobile.png') });

  // 보고서 HTTP 응답이 늦는 동안의 사용자 변경도 적용 직전에 다시 확인한다.
  let releaseReport!: () => void, reportSeen!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; }), reportReady = new Promise<void>(resolve => { reportSeen = resolve; });
  await page.route(`**/api/conversations/${conversation.id}`, async route => {
    const response = await route.fetch(); reportSeen(); await reportGate; await route.fulfill({ response });
  });
  const delayed = await tool('write_report', { country: '핀란드', system: '자주포' });
  await reportReady; await page.evaluate(() => (window as any).__app.focusCountry('CAN')); releaseReport();
  await confirmed(delayed); assert.equal((await state()).focus, 'FIN');
  await page.unroute(`**/api/conversations/${conversation.id}`);
  const savedReport = await repo.one('SELECT * FROM reports WHERE id=?', delayed.reportId);
  const result = { reply: '보고서를 저장했습니다.', actions: [], reports: [savedReport.markdown], tools: ['write_report'], reportRefs: [{ id: savedReport.id, country: 'FIN', system: 'sph', kind: 'country-analysis', basisDate: savedReport.basis_date, dataVersion: savedReport.data_version }] };
  await repo.message(conversation.id, 'model', result.reply, result);
  await repo.run("UPDATE runs SET status='completed',ended_at=?,result=? WHERE id=?", now(), JSON.stringify(result), runId);
  await page.waitForFunction(() => document.querySelector('#chatStatus')!.textContent === '완료');
  assert.equal((await state()).focus, 'FIN'); assert.equal((await state()).activeView, 'report');
  assert.deepEqual(errors, []);
  const receipt = { sequentialCommands: 'pass', pendingBatch: 'pass', acknowledgementRetry: 'pass', repeatedToggle: 'pass', hiddenTab: 'pass', directResult: 'pass', alwaysApply: 'pass', mapControls: 'pass', reportDuringRun: 'pass', mobileReport: 'pass', delayedReport: 'pass', completionKeepsView: 'pass', errors };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, folder }));
} finally {
  await browser.close();
  await repo.run("UPDATE runs SET status='cancelled',ended_at=? WHERE id=?", now(), runId);
  await repo.deleteConversation(conversation.id); await repo.close();
}
