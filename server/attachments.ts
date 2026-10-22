import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { PDFParse } from 'pdf-parse';
import { Store } from './store';
import { safeError } from './config';
import type { Attachment } from '../shared/types';
export async function extractText(bytes: Buffer, name: string): Promise<string> {
  const ext = extname(name).toLowerCase();
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.html'].includes(ext)) return bytes.toString('utf8');
  if (ext === '.docx') {
    const zip = unzipSync(bytes, { filter: f => f.name === 'word/document.xml' && f.originalSize < 20 * 1024 * 1024 });
    const part = zip['word/document.xml'];
    if (!part) throw new Error('Word 본문을 읽을 수 없거나 허용 크기를 넘었습니다.');
    const xml = strFromU8(part), parser = new SaxesParser({ xmlns: true });
    let text = '', insideText = false;
    parser.on('opentag', t => { if (t.local === 't') insideText = true; if (t.local === 'tab') text += '\t'; if (t.local === 'br') text += '\n'; });
    parser.on('text', t => { if (insideText) text += t; });
    parser.on('closetag', t => { if (t.local === 't') insideText = false; if (t.local === 'p' || t.local === 'tr') text += '\n'; if (t.local === 'tc') text += '\t'; });
    parser.write(xml).close(); return text.trim();
  }
  if (ext === '.pdf') {
    const pdf = new PDFParse({ data: new Uint8Array(bytes) });
    try { return (await pdf.getText()).text; } finally { await pdf.destroy(); }
  }
  return '';
}
export async function addAttachment(store: Store, reportId: string, name: string, mime: string, bytes: Buffer): Promise<Attachment> {
  return store.withFiles(reportId, async () => {
  const id = randomUUID();
  const filename = basename(name).replace(/[^\p{L}\p{N}_. -]/gu, '_');
  const path = `attachments/${id}-${filename}`;
  const root = store.workspace(reportId);
  await mkdir(join(root, 'attachments'), { recursive: true });
  await writeFile(join(root, path), bytes);
  const attachment: Attachment = { id, name: filename, mime, bytes: bytes.length, path, extracted: false };
  try {
    const text = await extractText(bytes, name);
    if (text.trim()) { attachment.textPath = path + '.txt'; await writeFile(join(root, attachment.textPath), text, 'utf8'); attachment.extracted = true; }
    else if (!mime.startsWith('image/')) attachment.error = '추출 가능한 텍스트가 없습니다. 스캔 PDF는 텍스트 또는 페이지 이미지로 첨부해주세요.';
  } catch (e) { attachment.error = safeError(e); }
  store.change(reportId, r => { r.attachments.push(attachment); });
  return attachment;
  });
}
