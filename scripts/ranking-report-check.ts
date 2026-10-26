/** Isolated browser check for the Plotly report timeline on desktop and mobile. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Locator, type Page } from 'playwright-core';

const folder = resolve('.local/verification', `ranking-report-${Date.now()}`);
mkdirSync(folder, { recursive: true });
const server = spawn(process.execPath, ['--import', 'tsx', 'server/node.ts'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, NODE_ENV: 'test', RADAR_DATABASE: 'sqlite', RADAR_STORAGE_DIR: folder, RADAR_DB_PATH: resolve(folder, 'test.sqlite'), PORT: '0' },
});
let log = '';
server.stdout.on('data', chunk => { log += chunk; });
server.stderr.on('data', chunk => { log += chunk; });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (let i = 0; i < 100 && !/http:\/\/localhost:\d+/.test(log) && server.exitCode == null; i++) await new Promise(r => setTimeout(r, 200));
  const port = log.match(/http:\/\/localhost:(\d+)/)?.[1];
  assert.ok(port, `격리 서버 시작 실패: ${log.slice(-400)}`);
  const activeBrowser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
  browser = activeBrowser;
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page: Page = await activeBrowser.newPage({ viewport });
    const errors: string[] = [];
    let exportedPdfHtml = '';
    page.on('request', request => { if (request.url().includes('/api/report-export/pdf')) exportedPdfHtml = request.postDataJSON().html; });
    page.on('pageerror', (error: Error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('body.ready');
    await page.click('#reportViewBtn');
    const sections = page.locator('.rank-section');
    assert.deepEqual(await sections.locator('h2').allTextContents(), [
      '예상 수주 매출 구성비', '연도별 예상 수주액 추이', '무기별 예상 수주 국가', '국가별 예상 수주 무기',
    ]);
    assert.equal(await page.locator('.rank-hero h1').textContent(), '예상 수주 전망 보고서');
    assert.equal(await page.locator('.rank-hero p, .rank-eyebrow, .rank-footnote').count(), 0);
    assert.match((await sections.nth(0).locator('.rank-section-head p').textContent()) ?? '', /^3년 내/);
    assert.equal(await sections.nth(0).locator('.rank-revenue-detail > p').count(), 0);
    assert.equal(await sections.nth(1).locator('.rank-timeline-head p, .rank-revenue-note').count(), 0);
    assert.equal(await sections.nth(3).locator(':scope > .rank-grid > .rank-card').count(), 6);
    assert.ok(await sections.nth(3).locator('.rank-more .rank-card').count() > 0);
    assert.ok(!/^[A-Z]{2}\s/.test((await sections.nth(3).locator('.rank-card-head h3').first().textContent()) ?? ''));
    assert.equal(await sections.nth(2).locator('thead th').first().evaluate(element => getComputedStyle(element).textAlign), 'center');
    const legendStarts = await sections.nth(0).locator('.rank-revenue-detail li small').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
    assert.ok(Math.max(...legendStarts) - Math.min(...legendStarts) < 1);
    for (const sectionIndex of [2, 3]) {
      const cells = sections.nth(sectionIndex).locator('.rank-card').first().locator('tbody tr').first();
      assert.deepEqual(await cells.locator('th, td').evaluateAll(elements => elements.map(element => getComputedStyle(element).textAlign)),
        ['center', 'center', 'right', 'center', 'center']);
    }
    await sections.nth(2).locator('.rank-card').first().screenshot({ path: resolve(folder, `system-table-${viewport.width}.png`) });
    await sections.nth(3).locator('.rank-card').first().screenshot({ path: resolve(folder, `country-table-${viewport.width}.png`) });
    if (viewport.width < 760) {
      const tableScroll = await sections.nth(2).locator('.rank-table-wrap').first().evaluate(element => {
        element.scrollLeft = element.scrollWidth;
        return { left: element.scrollLeft, width: element.clientWidth, content: element.scrollWidth };
      });
      assert.ok(tableScroll.content > tableScroll.width && tableScroll.left > 0);
      await sections.nth(2).locator('.rank-card').first().screenshot({ path: resolve(folder, `system-table-end-${viewport.width}.png`) });
    }
    assert.equal(await page.locator('.rank-pred-plan').first().textContent(), '공개 계획');
    await sections.nth(0).screenshot({ path: resolve(folder, `revenue-${viewport.width}.png`) });
    const plot: Locator = page.locator('#rankTimelinePlot');
    await page.waitForSelector('#rankTimelinePlot.js-plotly-plot', { timeout: 30000 });
    await plot.scrollIntoViewIfNeeded();
    const state = () => page.evaluate(() => {
      const graph = document.querySelector('#rankTimelinePlot') as HTMLElement & { data: { line: { color: string }; y: number[]; visible?: string }[]; _fullData: { visible?: string }[]; layout: { xaxis: { range: number[] }; yaxis: { range: number[] } } };
      return { traces: graph.data.length, colors: graph.data.map(trace => trace.line.color), range: graph.layout.xaxis.range, yRange: graph.layout.yaxis.range, maxValue: Math.max(...graph.data.flatMap(trace => trace.y)), firstVisible: graph._fullData[0].visible };
    });
    const initial = await state();
    assert.equal(initial.traces, 6);
    assert.equal(initial.range[1] - initial.range[0], 20);
    assert.ok(Math.abs(initial.yRange[1] - initial.maxValue * 1.05) < 1);
    const plotLegend = await plot.locator('.legend').evaluate(element => ({ opacity: getComputedStyle(element).opacity, pointerEvents: getComputedStyle(element).pointerEvents }));
    assert.deepEqual(plotLegend, { opacity: '1', pointerEvents: 'all' });
    const area = await plot.locator('.nsewdrag').boundingBox();
    assert.ok(area);
    await page.mouse.move(area.x + area.width * .25, area.y + area.height * .35);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width * .65, area.y + area.height * .7, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((width: number) => {
      const graph = document.querySelector('#rankTimelinePlot') as HTMLElement & { layout: { xaxis: { range: number[] } } };
      return graph.layout.xaxis.range[1] - graph.layout.xaxis.range[0] < width;
    }, initial.range[1] - initial.range[0]);
    const zoomed = await state();
    assert.ok(zoomed.range[1] - zoomed.range[0] < initial.range[1] - initial.range[0]);
    await page.mouse.dblclick(area.x + area.width / 2, area.y + area.height / 2);
    await page.waitForFunction((width: number) => {
      const graph = document.querySelector('#rankTimelinePlot') as HTMLElement & { layout: { xaxis: { range: number[] } } };
      return graph.layout.xaxis.range[1] - graph.layout.xaxis.range[0] >= width - 1;
    }, initial.range[1] - initial.range[0]);
    await page.waitForFunction((expected: number) => {
      const graph = document.querySelector('#rankTimelinePlot') as HTMLElement & { layout: { yaxis: { range: number[] } } };
      return Math.abs(graph.layout.yaxis.range[1] - expected) < 1;
    }, initial.yRange[1]);
    await plot.locator('.legend .traces').first().click();
    await page.waitForFunction(() => (document.querySelector('#rankTimelinePlot') as HTMLElement & { _fullData: { visible?: string }[] })._fullData[0].visible === 'legendonly');
    assert.equal((await state()).firstVisible, 'legendonly');
    await plot.locator('.legend .traces').first().click();
    await page.waitForFunction(() => (document.querySelector('#rankTimelinePlot') as HTMLElement & { _fullData: { visible?: string }[] })._fullData[0].visible !== 'legendonly');
    assert.notEqual((await state()).firstVisible, 'legendonly');
    await sections.nth(1).screenshot({ path: resolve(folder, `timeline-${viewport.width}.png`) });
    await sections.nth(3).locator('.rank-more summary').click();
    assert.ok(await sections.nth(3).locator('.rank-more[open] .rank-card:visible').count() > 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(folder, `report-${viewport.width}.png`) });
    await page.locator('.rank-export-button').click();
    await page.evaluate(() => {
      const doc = (window as any).reportEditor.getDoc();
      doc.blocks.find((block: any) => block.type === 'chart').chartType = 'bar';
      localStorage.setItem(`report-draft:${doc.id}`, JSON.stringify(doc));
      localStorage.removeItem(`report-composition-recovery:v1:${doc.id}`);
    });
    await page.locator('[data-action="close"]').click();
    await page.locator('.rank-export-button').click();
    assert.equal(await page.locator('.re-preview').count(), 0);
    assert.ok(await page.locator('.re-edit-frame').isVisible());
    const editorFrame = page.frameLocator('.re-edit-frame');
    assert.ok(await editorFrame.locator('.mix-top .mix-visual svg path').count() > 0);
    await editorFrame.locator('.cover-logo').waitFor();
    assert.ok(await editorFrame.locator('.cover-logo').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
    assert.equal(await editorFrame.locator('.slide').nth(1).locator('header h2').textContent(), 'Executive Summary');
    assert.equal(await editorFrame.locator('.slide').nth(2).locator('header h2').textContent(), '01 예상 수주 매출 구성비');
    await page.frameLocator('.re-edit-frame').locator('[data-doc-title]').fill('편집 검증 보고서');
    assert.equal(await page.evaluate(() => (window as any).reportEditor.getDoc().title), '편집 검증 보고서');
    if (viewport.width > 780) {
      await page.frameLocator('.re-edit-frame').locator('h2[data-block]').first().fill('수정한 구성비');
      assert.ok(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.some((block: { type: string; text?: string }) => block.type === 'heading' && block.text === '수정한 구성비')));
      await page.frameLocator('.re-edit-frame').locator('table[data-block] tbody td').first().fill('편집한 체계');
      assert.equal(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.find((block: { type: string }) => block.type === 'table')?.rows[0][0]), '편집한 체계');
      await page.frameLocator('.re-edit-frame').locator('table[data-block] tbody td').first().press('Control+z');
      assert.notEqual(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.find((block: { type: string }) => block.type === 'table')?.rows[0][0]), '편집한 체계');
      await page.frameLocator('.re-edit-frame').locator('table[data-block] tbody td').first().press('Control+Shift+z');
      assert.equal(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.find((block: { type: string }) => block.type === 'table')?.rows[0][0]), '편집한 체계');
      await page.frameLocator('.re-edit-frame').locator('.mix-visual').first().click();
      const amount = page.locator('.re-inspector [data-value="0:0"]');
      await amount.fill('1234');
      await amount.press('Tab');
      assert.equal(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.find((block: { type: string }) => block.type === 'chart')?.series[0].values[0]), 1234);
      await page.locator('.re-inspector [data-chart-type]').selectOption('bar');
      assert.ok(await page.frameLocator('.re-edit-frame').locator('.mix-top .alt-chart').isVisible());
      await page.frameLocator('.re-edit-frame').locator('table[data-block] tbody td').first().click();
      await page.locator('.re-inspector [data-table="row+"]').click();
      assert.equal(await page.evaluate(() => (window as any).reportEditor.getDoc().blocks.find((block: { type: string }) => block.type === 'table')?.rows.length), 7);
    }
    await page.screenshot({ path: resolve(folder, `editor-${viewport.width}.png`) });
    await page.locator('[data-action="export-menu"]').click();
    assert.equal(await page.locator('[data-export="docx"]').count(), 0);
    const download = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('[data-export="pdf"]').click();
    const pdf = await download.catch(async error => { throw new Error(`${error}; 편집기 알림: ${await page.locator('.re-notice').textContent()}`); });
    assert.match(pdf.suggestedFilename(), /\.pdf$/);
    const pdfPath = resolve(folder, `export-${viewport.width}.pdf`);
    await pdf.saveAs(pdfPath);
    assert.equal(readFileSync(pdfPath).subarray(0, 5).toString(), '%PDF-');
    await page.locator('[data-action="export-menu"]').click();
    const htmlDownload = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('[data-export="html"]').click();
    const html = await htmlDownload;
    const htmlPath = resolve(folder, `export-${viewport.width}.html`);
    await html.saveAs(htmlPath);
    const htmlContent = readFileSync(htmlPath, 'utf8');
    assert.match(htmlContent, /편집 검증 보고서/);
    assert.equal(htmlContent, exportedPdfHtml, 'HTML과 PDF가 다른 보고서 양식을 사용함');
    const standalone = await activeBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
    await standalone.setContent(htmlContent);
    assert.equal(await standalone.locator('.slide').nth(1).locator('h2').textContent(), 'Executive Summary');
    assert.ok(await standalone.locator('.cover-logo').evaluate(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0));
    await standalone.screenshot({ path: resolve(folder, `html-${viewport.width}.png`) });
    await standalone.close();
    if (viewport.width > 780) {
      await page.evaluate(() => (window as any).reportEditor.open({ id: 'country-export-check', title: '국가 분석', source: { kind: 'country' }, blocks: [{ id: 'heading', type: 'heading', level: 2, text: '국가 분석' }, { id: 'body', type: 'paragraph', html: '편집할 수 있는 내용' }] }));
      assert.ok(await page.locator('.re-paper [data-doc-title]').isVisible());
      await page.locator('[data-action="export-menu"]').click();
      const countryDownload = page.waitForEvent('download', { timeout: 30000 });
      await page.locator('[data-export="pdf"]').click();
      const countryPdf = await countryDownload;
      const countryPath = resolve(folder, 'country-export.pdf');
      await countryPdf.saveAs(countryPath);
      assert.equal(readFileSync(countryPath).subarray(0, 5).toString(), '%PDF-');
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`보고서 그래프와 편집·PDF 다운로드 확인 완료: ${folder}`);
} finally {
  await browser?.close();
  server.kill();
}
