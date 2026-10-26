import { chromium, type BrowserType } from 'playwright-core';

export async function renderReportPdf(html: string, browserType: BrowserType = chromium, layout: 'a4' | 'landscape' = 'a4'): Promise<Uint8Array> {
  if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) throw new Error('PDF 변환 문서가 너무 큽니다. 5MB 이하로 줄여 주세요.');
  let browser;
  try { browser = await browserType.launch({ channel: 'msedge', headless: true }); }
  catch {
    try { browser = await browserType.launch({ channel: 'chrome', headless: true }); }
    catch { throw new Error('PDF 내보내기에는 Microsoft Edge 또는 Chrome 설치가 필요합니다.'); }
  }
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    page.setDefaultTimeout(25_000);
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: 'load', timeout: 25_000 });
    return await page.pdf(layout === 'landscape'
      ? { width: '10.833333in', height: '7.5in', printBackground: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } }
      : { format: 'A4', printBackground: true, displayHeaderFooter: true, margin: { top: '22mm', right: '18mm', bottom: '22mm', left: '18mm' }, headerTemplate: '<span></span>', footerTemplate: '<div style="font:9px Arial;width:100%;text-align:center;color:#64748b"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  } finally { await browser.close(); }
}
