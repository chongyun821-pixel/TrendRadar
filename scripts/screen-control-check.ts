import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { repository, now } from '../server/store';
import { executions } from '../server/execution';
import { runTool, newOut } from '../server/agent';
import type { AppContext } from '../shared/app-context';

// 실행 중인 격리 SQLite 서버와 같은 저장 경로를 지정한다. 모델과 운영 DB는 호출하지 않는다.
assert.equal(process.env.RADAR_DATABASE, 'sqlite');
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.RADAR_DB_PATH);
const base = process.env.BASE_URL || 'http://localhost:62401';
// 이 프로세스의 화면 도구는 앱 서버의 화면 허브(/api/screen/command)로 명령을 보낸다(DB 미사용)
process.env.RADAR_APP_URL = base;
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
const active = { runId, conversationId: conversation.id };
async function startRun(conversationId: string) {
  const id = randomUUID();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', id, conversationId, 'test-screen', 'running', now(), process.pid);
  Object.assign(active, { runId: id, conversationId });
}
async function tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
  return executions.run({ repo, runId: active.runId, conversationId: active.conversationId, appContext: requestContext, signal: new AbortController().signal, env: {} }, () => runTool(name, args, newOut()));
}
const appCommands = async () => Number((await repo.one('SELECT count(*) AS n FROM app_commands')).n);
const commandsBefore = await appCommands();
const applied = (result: any) => assert.equal(result.status, 'applied', JSON.stringify(result));
try {
  await page.addInitScript(id => localStorage.setItem('pr.conversation', id), conversation.id);
  await page.goto(base); await page.waitForSelector('body.ready');
  await page.waitForFunction(id => (window as any).__app.getAppContext().conversationId === id, conversation.id);
  requestContext = await state();
  await repo.event(runId, 'app.context', requestContext);
  await page.waitForFunction(async () => (await (await fetch('/api/screen/context')).json()).available);

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

  // 동시에 보낸 명령도 받은 순서대로 하나씩 적용한다.
  const [mode, focus] = await Promise.all([tool('set_map_state', { system: '대공미사일' }), tool('set_map_state', { country: '핀란드' })]);
  applied(mode); applied(focus);
  assert.equal((await state()).mode, 'sam'); assert.equal((await state()).focus, 'FIN');

  // 적용 결과 전송이 실패해도 명령을 다시 실행하지 않고 결과만 재전송한다(상대 확대로 중복 적용 여부 확인).
  let failedResults = 0;
  await page.route('**/api/screen/results/*', async route => { if (!failedResults++) await route.abort(); else await route.continue(); });
  applied(await tool('set_map_state', { flat: true }));
  assert.equal((await state()).flat, true);
  assert.ok(failedResults >= 2);
  await page.unroute('**/api/screen/results/*');
  applied(await tool('set_map_state', { flat: '3D' }));
  assert.equal((await state()).flat, false);

  // 사용자가 그사이 화면을 바꿨어도 챗봇의 화면 명령은 적용된다(버전·충돌 개념 없음).
  await page.evaluate(() => (window as any).__app.focusCountry('AUS'));
  const korea = await tool('set_map_state', { country: '한국' });
  applied(korea); assert.equal((await state()).focus, 'KOR');
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

  // 탭이 백그라운드여도 명령은 적용되고 hidden과 안내가 붙는다
  requestContext = await state();
  const setHidden = (hidden: boolean) => page.evaluate(`Object.defineProperty(document, 'hidden', { configurable: true, value: ${hidden} }); document.dispatchEvent(new Event('visibilitychange'))`);
  await setHidden(true);
  await page.waitForFunction(async () => (await (await fetch('/api/screen/context')).json()).hidden === true);
  const background = await tool('set_map_state', { country: '일본' });
  applied(background); assert.equal(background.hidden, true); assert.match(background.message, /백그라운드/);
  assert.equal((await state()).focus, 'JPN');
  await setHidden(false);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await tool('write_report', { country: '폴란드', system: '다연장로켓' });
  applied(mobile); assert.equal(mobile.shown, true);
  current = await state(); assert.equal(current.report?.id, mobile.reportId);
  assert.equal(current.focus, 'POL'); assert.equal(current.mode, 'mrl'); assert.equal(current.activeView, 'report');
  assert.equal(await page.locator('#modes button.on').getAttribute('data-sys'), 'mrl');
  await page.waitForFunction(() => !(window as any).__globe.camAnim && document.querySelector('#modes')!.getAnimations({ subtree: true }).every(a => a.playState === 'finished'));
  await page.screenshot({ path: join(folder, 'poland-mrl-report-mobile.png') });

  // 보고서 HTTP 응답이 늦는 동안 사용자가 화면을 바꿔도 보고서 표시는 그대로 적용된다.
  let releaseReport!: () => void, reportSeen!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; }), reportReady = new Promise<void>(resolve => { reportSeen = resolve; });
  await page.route(`**/api/conversations/${conversation.id}`, async route => {
    const response = await route.fetch(); reportSeen(); await reportGate; await route.fulfill({ response });
  });
  const delayedCall = tool('write_report', { country: '핀란드', system: '자주포' });
  await reportReady; await page.evaluate(() => (window as any).__app.focusCountry('CAN')); releaseReport();
  const delayed = await delayedCall;
  applied(delayed); assert.equal((await state()).focus, 'FIN');
  await page.unroute(`**/api/conversations/${conversation.id}`);
  const savedReport = await repo.one('SELECT * FROM reports WHERE id=?', delayed.reportId);
  const result = { reply: '보고서를 저장했습니다.', actions: [], reports: [savedReport.markdown], tools: ['write_report'], reportRefs: [{ id: savedReport.id, country: 'FIN', system: 'sph', kind: 'country-analysis', basisDate: savedReport.basis_date, dataVersion: savedReport.data_version }] };
  await repo.message(conversation.id, 'model', result.reply, result);
  await repo.run("UPDATE runs SET status='completed',ended_at=?,result=? WHERE id=?", now(), JSON.stringify(result), runId);
  await page.waitForFunction(() => document.querySelector('#chatStatus')!.textContent === '완료');
  assert.equal((await state()).focus, 'FIN'); assert.equal((await state()).activeView, 'report');

  // 이후 도구 호출은 화면에 열린 대화와 무관한 별도 실행에서 보낸다(화면 명령은 대화와 무관하게 최근 탭으로 간다)
  const other = await repo.createConversation('화면 연속 제어 검증(다중 탭)');
  await startRun(other.id);

  // 탭이 여러 개면 가장 최근에 사용한 탭 하나로 보낸다.
  const second = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  second.on('pageerror', error => errors.push(String(error)));
  await second.goto(base); await second.waitForSelector('body.ready');
  await second.waitForFunction(async () => (await (await fetch('/api/screen/context')).json()).screens === 2);
  await second.mouse.click(5, 300); // 활동 알림
  await second.waitForFunction(async () => { const c = await (await fetch('/api/screen/context')).json(); return c.screenId === (window as any).__app.getAppContext().screenId; });
  applied(await tool('set_map_state', { country: '독일' }));
  assert.equal(await second.evaluate(() => (window as any).__app.getAppContext().focus), 'DEU'); assert.equal((await state()).focus, 'FIN');
  await page.bringToFront(); await page.mouse.click(5, 300);
  await page.waitForFunction(async () => { const c = await (await fetch('/api/screen/context')).json(); return c.screenId === (window as any).__app.getAppContext().screenId; });
  applied(await tool('set_map_state', { country: '체코' }));
  assert.equal((await state()).focus, 'CZE');
  await second.close();

  // 외부 코덱스와 같은 경로: 실행 중인 HTTP MCP(헤더 없음)의 set_map_state가 이 지도를 움직인다.
  await page.setViewportSize({ width: 1440, height: 900 });
  const mcpPort = Number(process.env.SCREEN_MCP_PORT || 62402);
  const mcp = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'mcp/server.ts', '--http', '--port', String(mcpPort)], { env: { ...process.env, RADAR_APP_URL: base }, stdio: ['ignore', 'ignore', 'pipe'] });
  let mcpResult: any, noBrowser: any, noBrowserMs = 0;
  try {
    await new Promise<void>((resolve, reject) => { mcp.stderr!.on('data', d => { if (String(d).includes('Streamable HTTP')) resolve(); }); mcp.on('exit', code => reject(new Error(`HTTP MCP 종료 ${code}`))); });
    const external = async (args: Record<string, unknown>) => {
      const client = new Client({ name: 'screen-check', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`)));
      try { return JSON.parse((await client.callTool({ name: 'set_map_state', arguments: args }) as any).content[0].text); } finally { await client.close(); }
    };
    mcpResult = await external({ country: '루마니아', system: '자주포', flat: true });
    applied(mcpResult);
    assert.equal((await state()).focus, 'ROU'); assert.equal((await state()).mode, 'sph'); assert.equal((await state()).flat, true);
    await settle();
    await page.waitForFunction(() => (window as any).__globe.colorAnim >= 1 && (window as any).__globe.spikeT >= 1);
    await page.screenshot({ path: join(folder, 'mcp-http-romania-2d.png') });
    assert.deepEqual(errors, []);
    // 브라우저를 닫으면 바로 inactive
    await page.close();
    for (let i = 0; i < 50 && (await (await fetch(`${base}/api/screen/context`)).json()).available; i++) await new Promise(r => setTimeout(r, 100));
    const started = Date.now();
    noBrowser = await external({ country: '폴란드' });
    noBrowserMs = Date.now() - started;
    assert.equal(noBrowser.status, 'inactive', JSON.stringify(noBrowser)); assert.match(noBrowser.message, /화면이 열려 있지 않음/);
    assert.ok(noBrowserMs < 1500, `inactive ${noBrowserMs}ms`);
    const inProcess = await tool('set_map_state', { country: '폴란드' });
    assert.equal(inProcess.status, 'inactive', JSON.stringify(inProcess));
  } finally { mcp.kill(); }
  // 화면 명령은 DB(app_commands)에 남지 않는다
  assert.equal(await appCommands(), commandsBefore);

  const receipt = { sequentialCommands: 'pass', concurrentCommands: 'pass', resultRetry: 'pass', hiddenTab: 'pass', alwaysApply: 'pass', mapControls: 'pass', reportDuringRun: 'pass', mobileReport: 'pass', delayedReport: 'pass', completionKeepsView: 'pass', latestTab: 'pass', mcpHttp: mcpResult.status, noBrowser: { status: noBrowser.status, ms: noBrowserMs }, appCommandsUnchanged: true, errors };
  writeFileSync(join(folder, 'result.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ ...receipt, folder }));
} finally {
  await browser.close();
  for (const id of new Set([runId, active.runId])) await repo.run("UPDATE runs SET status='cancelled',ended_at=? WHERE id=? AND status='running'", now(), id);
  for (const id of new Set([conversation.id, active.conversationId])) await repo.deleteConversation(id);
  await repo.close();
}
