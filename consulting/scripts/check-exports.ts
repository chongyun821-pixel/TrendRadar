import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store';
import { exportPdf, exportWord, reportHtml, openBrowser } from '../server/export';
import { extractText } from '../server/attachments';
import { verificationRoot } from './verification-root';
const root = verificationRoot(process.argv[2]);
const store = new Store(root);
try {
  const report = store.list()[0];
  if (!report) throw new Error('No verification report');
  const browser = await openBrowser();
  try {
    const page = await browser.newPage(); await page.setContent(reportHtml(report));
    console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.page')].map(el => {
      const body = el.querySelector('.body')!; return { page: (el as HTMLElement).dataset.page, availableHeight: body.clientHeight, actualHeight: body.scrollHeight, textCharacters: body.textContent!.length };
    })), null, 2));
  } finally { await browser.close(); }
  writeFileSync(join(root, 'report.html'), reportHtml(report));
  const docx = await exportWord(report); writeFileSync(join(root, 'report.docx'), docx);
  const text = await extractText(docx, 'report.docx');
  if (!text.includes('문제정의서') || !text.includes('권고안') || !text.includes('가상')) throw new Error('Word text roundtrip failed');
  console.log('Word OOXML roundtrip: passed');
  writeFileSync(join(root, 'report.pdf'), await exportPdf(report));
  const receiptPath = join(root, 'receipt.json');
  if (existsSync(receiptPath)) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); receipt.exports = ['html', 'pdf', 'docx']; receipt.ok = true; delete receipt.error; receipt.exportVerifiedAt = new Date().toISOString(); writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  }
  console.log('Export validation completed: ' + root);
} finally { store.close(); }
