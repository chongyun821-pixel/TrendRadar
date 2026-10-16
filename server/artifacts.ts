import { readFileSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { execution, type Execution } from './execution';
import { hash } from './store';

export interface ArtifactDownload { id: string; name: string; url: string }
export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** CLI의 기존 문서 도구가 완성한 파일을 검증·보존한다. 문서 내용이나 서식은 만들지 않는다. */
export function publishArtifact(path: string, ctx: Execution = execution()): ArtifactDownload {
  ctx.signal.throwIfAborted();
  const { repo, conversationId, runId } = ctx;
  const file = repo.path(conversationId, path, true);
  if (!/\.docx$/i.test(file)) throw new Error('완성된 .docx 파일을 지정하세요');
  if (statSync(file).size > 40 * 1024 * 1024) throw new Error('Word 파일은 40MB까지 등록할 수 있습니다');
  const bytes = readFileSync(file);
  let total = 0;
  const parts = unzipSync(bytes, { filter: entry => {
    if (!['[Content_Types].xml', 'word/document.xml'].includes(entry.name)) return false;
    total += entry.originalSize;
    if (total > 40 * 1024 * 1024) throw new Error('Word 본문 크기 초과');
    return true;
  } });
  if (!parts['word/document.xml'] || !parts['[Content_Types].xml'] || !strFromU8(parts['word/document.xml']).includes('<w:document')) throw new Error('유효한 Word 문서가 아닙니다');
  const digest = hash(bytes);
  const old = repo.one("SELECT * FROM artifacts WHERE conversation_id=? AND kind='document' AND hash=?", conversationId, digest);
  if (old) { repo.event(runId, 'artifact.published', { id: old.id, name: old.name }); return download(old, conversationId); }
  const name = basename(file).replace(/[^\p{L}\p{N}._ -]/gu, '_');
  // 도구가 나중에 원본을 수정하더라도 이 메시지의 다운로드 파일은 변하지 않게 보존한다.
  const artifact = repo.artifact(conversationId, `reports/downloads/${randomUUID()}/${name}`, bytes, { runId, kind: 'document', mime: WORD_MIME });
  repo.event(runId, 'artifact.published', { id: artifact.id, name: artifact.name, source: relative(repo.workspace(conversationId), file) });
  return download(artifact, conversationId);
}
function download(file: { id: string; name: string }, conversationId: string): ArtifactDownload {
  return { id: file.id, name: file.name.split('/').at(-1)!, url: `/api/conversations/${conversationId}/files/${file.id}` };
}

/** 문서 스킬이 검증 후 명시적으로 등록한 결과만 메시지에 연결한다. */
export function collectDocuments(ctx: Execution): ArtifactDownload[] {
  const { repo, conversationId, runId } = ctx;
  ctx.signal.throwIfAborted();
  const published = new Set(repo.all("SELECT data FROM events WHERE run_id=? AND name='artifact.published'", runId).map(event => JSON.parse(event.data).id));
  return repo.all("SELECT * FROM artifacts WHERE conversation_id=? AND kind='document'", conversationId).filter(file => file.run_id === runId || published.has(file.id)).map(file => download(file, conversationId));
}
