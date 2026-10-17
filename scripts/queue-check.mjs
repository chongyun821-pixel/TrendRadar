import { chromium } from 'playwright-core';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// 격리 SQLite 서버의 가상 실행 뒤에 로컬 명령을 대기시킨다. 제공 모델은 호출하지 않는다.
const base = process.env.BASE_URL || 'http://localhost:62401';
assert.equal((await (await fetch(`${base}/api/health`)).json()).storage, 'sqlite');
assert.ok(process.env.RADAR_DB_PATH, '격리 서버의 RADAR_DB_PATH를 지정하세요');
const db = new DatabaseSync(process.env.RADAR_DB_PATH);
const launch = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH; else launch.channel = 'chrome';
const browser = await chromium.launch(launch), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const ids = [], errors = [], folder = `.local/verification/chat-queue-${Date.now()}`;
mkdirSync(folder, { recursive: true });
page.on('pageerror', error => errors.push(String(error)));
let blocker;
async function send(text) { await page.fill('#q', text); await page.press('#q', 'Enter'); }
async function finished() { await page.waitForFunction(() => document.querySelector('#chatStatus').textContent === '완료'); }
try {
  await page.goto(base); await page.waitForSelector('body.ready');
  await send('!help'); await finished();
  const id = await page.evaluate(() => localStorage.getItem('pr.conversation')); ids.push(id);
  blocker = randomUUID();
  db.prepare('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)').run(blocker, id, 'test-queue', 'running', new Date().toISOString(), process.pid);
  db.prepare('INSERT INTO events(run_id,name,data,created_at) VALUES(?,?,?,?)').run(blocker, 'model.request', JSON.stringify({ model: 'nvidia/nemotron-3-super-120b-a12b:free' }), new Date().toISOString());
  await page.reload(); await page.waitForSelector('body.ready');
  await page.waitForFunction(() => document.querySelector('.status-message')?.textContent === '답변 준비 중');
  await page.fill('#q', '!목록 호위함'); assert.equal(await page.locator('.send').isVisible(), true);
  assert.equal(await page.locator('#stopButton').isVisible(), true);
  await page.click('.send');
  await send('!예측 베트남 자주포'); await send('!모드 일반');
  await page.waitForFunction(() => document.querySelectorAll('.queued-heading button').length === 3);
  const queued = db.prepare("SELECT id FROM runs WHERE conversation_id=? AND status='queued' ORDER BY rowid").all(id);
  assert.equal(queued.length, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id=?').get(id).n, 2);
  await page.screenshot({ path: `${folder}/desktop.png` });
  await page.reload(); await page.waitForSelector('body.ready');
  await page.waitForFunction(() => document.querySelectorAll('.queued-heading button').length === 3);
  await page.click('#historyToggle'); await page.click('#chatReset');
  await send('!help'); await finished();
  ids.push(await page.evaluate(() => localStorage.getItem('pr.conversation')));
  await page.click('#historyToggle'); await page.locator(`button[data-conversation-id="${id}"]`).click();
  await page.waitForFunction(() => document.querySelectorAll('.queued-heading button').length === 3);
  await page.getByRole('button', { name: '대기 메시지 3 취소', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.queued-heading button').length === 2);
  assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(queued[2].id).status, 'cancelled');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.fill('#q', '다음 메시지');
  assert.equal(await page.locator('.send').isVisible(), true);
  const sendBounds = await page.locator('.send').boundingBox(), stopBounds = await page.locator('#stopButton').boundingBox();
  assert.ok(stopBounds.x + stopBounds.width <= sendBounds.x);
  assert.ok(sendBounds.x + sendBounds.width <= 391);
  assert.ok((await page.locator('#chatStatus').boundingBox()).height < 40);
  await page.screenshot({ path: `${folder}/mobile.png` });
  await page.fill('#q', '');
  db.prepare("UPDATE runs SET status='completed',ended_at=? WHERE id=?").run(new Date().toISOString(), blocker);
  await page.waitForFunction(() => document.querySelectorAll('.m.user:not(.queued)').length === 3 && document.querySelector('#chatStatus').textContent === '완료');
  assert.equal(await page.locator('.m.queued').count(), 0);
  const stored = await (await page.request.get(`${base}/api/conversations/${id}`)).json();
  assert.deepEqual(stored.messages.filter(m => m.role === 'user').map(m => m.text), ['!help', '!목록 호위함', '!예측 베트남 자주포']);
  assert.deepEqual(stored.messages.map(m => m.role), ['user', 'model', 'user', 'model', 'user', 'model']);
  assert.deepEqual(errors, []);
  const result = { enqueueDuringResponse: 'pass', order: 'pass', reload: 'pass', conversationSwitch: 'pass', cancelQueued: 'pass', desktop: 'pass', mobile: 'pass', compactStatus: 'pass', actualProviderInvoked: false, errors };
  writeFileSync(`${folder}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, folder }));
} finally {
  if (blocker) db.prepare("UPDATE runs SET status='completed' WHERE id=? AND status='running'").run(blocker);
  for (const id of ids) await page.request.delete(`${base}/api/conversations/${id}`);
  db.close(); await browser.close();
}
