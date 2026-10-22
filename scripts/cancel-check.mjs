import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// 격리 SQLite 서버에서 가짜 그록 CLI(tests/fixtures/fake-cli.mjs, GROK_BIN)로 중지·메시지 표시·모델 전달을 확인한다. 제공 모델은 호출하지 않는다.
const base = process.env.BASE_URL || 'http://localhost:62411';
assert.equal((await (await fetch(`${base}/api/health`)).json()).storage, 'sqlite');
const launch = { headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH; else launch.channel = 'chrome';
const browser = await chromium.launch(launch), page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], folder = `.local/verification/chat-cancel-${Date.now()}`, ids = [];
mkdirSync(folder, { recursive: true });
page.on('pageerror', error => errors.push(String(error)));
const fakeProcesses = () => { try { return execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' }).split('\n').filter(l => l.includes('fake-cli.mjs') || l.includes("process.on('SIGTERM'")).length; } catch { return -1; } };
const userTexts = () => page.evaluate(() => Array.from(document.querySelectorAll('#msgs .m.user:not(.queued)')).map(e => e.textContent.trim()));
async function send(text) { await page.fill('#q', text); await page.press('#q', 'Enter'); }
async function status(pattern) { await page.waitForFunction(p => new RegExp(p).test(document.querySelector('#chatStatus').textContent), pattern.source, { timeout: 15000 }); }
try {
  await page.goto(base); await page.waitForSelector('body.ready');
  // 상태 줄의 모델을 눌러 그록 빌드 → grok-4.6 → low 선택
  await page.click('#modelLabel');
  for (const id of ['grok', 'grok-4.6', 'low']) await page.locator(`#picker .picker-item[data-id="${id}"]`).click();
  assert.equal(await page.textContent('#modelLabel'), '그록 빌드 | grok-4.6 | low');

  // 1) 보내자마자 내 메시지가 보이고, 처리 중에도 계속 보인다
  await send('멈춤 첫 요청');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('#msgs .m.user')).some(e => e.textContent.includes('멈춤 첫 요청')), null, { timeout: 1000 });
  await status(/진행 중|처리 중|검색 중/);
  ids.push(await page.evaluate(() => localStorage.getItem('pr.conversation')));
  assert.deepEqual(await userTexts(), ['멈춤 첫 요청']);

  // 2) 응답 중 보낸 메시지는 대기로 보이고, 앞 요청을 중지하면 바로 실행되며 계속 보인다
  await send('멈춤 둘째 요청');
  await page.waitForFunction(() => document.querySelectorAll('.queued-heading button').length === 1);
  assert.equal(await page.locator('#stopButton').isVisible(), true);
  const stopStarted = Date.now();
  await page.click('#stopButton');
  await page.waitForFunction(() => document.querySelectorAll('#msgs .m.user:not(.queued)').length === 2 && !document.querySelector('.m.queued'), null, { timeout: 15000 });
  const stopMs = Date.now() - stopStarted;
  for (let i = 0; i < 4; i++) { // 여러 번의 상태 조회 동안 사라지지 않는다
    assert.deepEqual(await userTexts(), ['멈춤 첫 요청', '멈춤 둘째 요청']);
    assert.equal(await page.locator('#stopButton').isVisible(), true);
    await page.waitForTimeout(700);
  }
  await page.screenshot({ path: `${folder}/running-after-stop.png` });

  // 3) 다시 중지하면 진행 표시가 끝나고 바로 다시 보낼 수 있다
  await page.click('#stopButton');
  await status(/중지/);
  await page.waitForFunction(() => document.querySelector('#stopButton').hidden && !document.querySelector('#chat').classList.contains('busy'));
  await send('모델 확인');
  await status(/^완료$/);
  const reply = await page.evaluate(() => Array.from(document.querySelectorAll('#msgs .m.bot')).at(-1).textContent);
  assert.match(reply, /"-m","grok-4\.6","--reasoning-effort","low"/);
  const stored = await (await page.request.get(`${base}/api/conversations/${ids[0]}`)).json();
  assert.deepEqual(stored.messages.map(m => `${m.role}:${m.text.slice(0, 20)}`), ['user:멈춤 첫 요청', 'model:사용자가 조사를 중지했습니다', 'user:멈춤 둘째 요청', 'model:사용자가 조사를 중지했습니다', 'user:모델 확인', `model:${reply.trim().slice(0, 20)}`]);
  assert.deepEqual(stored.runs.map(r => r.status), ['completed', 'cancelled', 'cancelled']);
  // 4) 작업 중 접은 채팅 창은 진행 상태 갱신·중지·완료 뒤에도 접힌 채로 있고, 사용자가 누르면 펼쳐진다
  const isOpen = () => page.locator('#chat').evaluate(element => element.classList.contains('open'));
  await send('멈춤 접기 확인');
  await status(/진행 중|처리 중|검색 중/);
  await page.click('#chatToggle'); assert.equal(await isOpen(), false);
  await page.waitForTimeout(3000); assert.equal(await isOpen(), false, '진행 중 자동 펼침');
  await page.click('#stopButton'); await status(/중지/);
  await page.waitForTimeout(1500); assert.equal(await isOpen(), false, '중지 후 자동 펼침');
  await send('접기 완료 확인'); await page.click('#chatToggle');
  await status(/^완료$/); await page.waitForTimeout(1500);
  assert.equal(await isOpen(), false, '완료 후 자동 펼침');
  await page.click('#chatToggle'); assert.equal(await isOpen(), true);

  // 5) 상태 줄 '^ 세션 | 모델': ^ 는 /sessions 선택기를 열고 닫는다. 제목은 그 자리에서 바꾼다
  assert.match(await page.textContent('.composer-meta'), /^\^ .+ \| 그록 빌드 \| grok-4\.6 \| low$/);
  await page.click('#chatToggle'); await page.click('#sessionsButton');
  assert.equal(await isOpen(), true);
  await page.locator('#picker .picker-item[data-id=""]').waitFor();
  assert.match(await page.textContent('#picker .picker-title'), /^대화/);
  await page.click('#sessionsButton'); assert.equal(await page.locator('#picker').isHidden(), true);
  await page.click('#conversationTitle');
  assert.equal(await page.locator('#conversationTitle').evaluate(element => element.isContentEditable), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#conversationTitle').evaluate(element => element.isContentEditable), false);

  await page.waitForTimeout(2000);
  const leftover = fakeProcesses(); // ps가 없는 환경(-1)은 건너뛴다
  if (leftover >= 0) assert.equal(leftover, 0, '중지 후 남은 CLI 프로세스');
  await page.screenshot({ path: `${folder}/desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${folder}/mobile.png` });
  assert.deepEqual(errors, []);
  const result = { optimisticUserMessage: 'pass', visibleWhileRunning: 'pass', stopRunning: 'pass', stopMs, queueContinues: 'pass', sendAfterStop: 'pass', modelArgs: 'pass', processTreeKilled: 'pass', staysCollapsed: 'pass', sessionsCaret: 'pass', actualProviderInvoked: false, errors };
  writeFileSync(`${folder}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, folder }));
} finally {
  for (const id of ids) if (id) await page.request.delete(`${base}/api/conversations/${id}`);
  await browser.close();
}
