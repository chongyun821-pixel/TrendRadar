import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { execution } from './execution';
import { readFileSync } from 'node:fs';
import type { Repository } from './store';

export async function attach(repo: Repository, conversationId: string, file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  const name = file.name.replace(/[^\p{L}\p{N}._ -]/gu, '_');
  const stem = `attachments/${randomUUID()}-${name}`;
  const original = await repo.artifact(conversationId, stem, bytes, { kind: 'attachment', mime: file.type || 'application/octet-stream' });
  if (await repo.one('SELECT 1 FROM artifacts WHERE conversation_id=? AND name=?', conversationId, `${original.name}.txt`)) return original;
  try {
    let text = '';
    const ext = extname(name).toLowerCase();
    if (ext === '.pdf') {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: bytes });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (ext === '.docx') {
      const { unzipSync, strFromU8 } = await import('fflate');
      let extractedBytes = 0;
      const entries = unzipSync(bytes, { filter: entry => {
        if (!/^word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(entry.name)) return false;
        extractedBytes += entry.originalSize;
        if (extractedBytes > 40 * 1024 * 1024) throw new Error('DOCX 압축 해제 텍스트가 40MB를 초과했습니다');
        return true;
      } });
      text = Object.entries(entries).map(([, value]) => strFromU8(value).replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<\/w:(p|tr)>/g, '\n').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<[^>]*>/g, '').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')).join('\n');
    }
    else if (/^text\//.test(file.type) || ['.md','.txt','.csv','.tsv','.json','.xml','.html','.log'].includes(ext)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    else if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return { ...original, extraction: 'image', message: '이미지 원본 첨부' };
    else return { ...original, extraction: 'unsupported', message: '원본은 저장했지만 텍스트 자동 추출은 지원하지 않습니다' };
    if (!text.trim()) throw new Error('추출 가능한 텍스트 없음 (스캔 문서 확인 필요)');
    const extracted = await repo.artifact(conversationId, `${original.name}.txt`, text, { kind: 'extracted', mime: 'text/plain' });
    return { ...original, extraction: 'ok', textPath: extracted.name };
  } catch (e) {
    await repo.run('UPDATE artifacts SET error=? WHERE id=?', String(e), original.id);
    return { ...original, extraction: 'failed', message: String(e) };
  }
}

export async function imageAttachments(): Promise<{ mime: string; base64: string; path: string }[]> {
  const ctx = await execution();
  const files = await ctx.repo.all("SELECT * FROM artifacts WHERE conversation_id=? AND kind='attachment' AND mime IN ('image/png','image/jpeg','image/webp')", ctx.conversationId);
  return Promise.all(files.map(async f => ({ mime: f.mime, path: f.path, base64: readFileSync(await ctx.repo.ensureFile(f.path)).toString('base64') })));
}
