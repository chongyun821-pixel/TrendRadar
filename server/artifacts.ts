import { readFileSync, statSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { execution, type Execution } from './execution';
import { hash } from './store';
import { z } from 'zod';

export interface ArtifactDownload { id: string; name: string; url: string }
export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const POWERPOINT_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** CLI의 기존 문서 도구가 완성한 파일을 검증·보존한다. 문서 내용이나 서식은 만들지 않는다. */
export async function publishArtifact(path: string, ctx?: Execution, metadata: { preparationId?: string; review?: string } = {}): Promise<ArtifactDownload> {
  ctx ??= await execution();
  ctx.signal.throwIfAborted();
  const { repo, conversationId, runId } = ctx;
  if ((await repo.runStatus(runId))?.status !== 'running') throw new Error('종료되거나 중지된 조사 실행');
  const file = await repo.ensureFile(repo.path(conversationId, path));
  if (!/\.(docx|pptx)$/i.test(file)) throw new Error('완성된 .docx 또는 .pptx 파일을 지정하세요');
  const ppt = /\.pptx$/i.test(file), main = ppt ? 'ppt/presentation.xml' : 'word/document.xml';
  if (statSync(file).size > 40 * 1024 * 1024) throw new Error('완성 문서는 40MB까지 등록할 수 있습니다');
  const bytes = readFileSync(file);
  let total = 0;
  const parts = unzipSync(bytes, { filter: entry => {
    if (!['[Content_Types].xml', main].includes(entry.name) && !(ppt && /^ppt\/(slides\/slide\d+\.xml|_rels\/presentation\.xml\.rels)$/.test(entry.name))) return false;
    total += entry.originalSize;
    if (total > 40 * 1024 * 1024) throw new Error('문서 본문 크기 초과');
    return true;
  } });
  const expectedMime = `${ppt ? POWERPOINT_MIME : WORD_MIME}.main+xml`;
  if (!parts[main] || !parts['[Content_Types].xml'] || !strFromU8(parts[main]).includes(ppt ? '<p:presentation' : '<w:document') || !strFromU8(parts['[Content_Types].xml']).includes(expectedMime)) throw new Error('유효한 워드 또는 파워포인트 문서가 아닙니다');
  if (ppt && (!Object.keys(parts).some(p => /^ppt\/slides\/slide\d+\.xml$/.test(p)) || !parts['ppt/_rels/presentation.xml.rels'])) throw new Error('파워포인트 슬라이드가 없습니다');
  let preparation: any = null;
  if (metadata.preparationId) {
    z.string().uuid().parse(metadata.preparationId);
    const saved = await repo.one("SELECT * FROM artifacts WHERE conversation_id=? AND name=? AND kind='report-packet'", conversationId, `reports/prepared/${metadata.preparationId}.json`);
    if (!saved) throw new Error('보고서 작성 자료가 없습니다');
    const bytes = readFileSync(await repo.ensureFile(saved.path));
    if (hash(bytes) !== saved.hash) throw new Error('보고서 작성 자료 해시 불일치');
    preparation = JSON.parse(bytes.toString('utf8'));
    if (preparation.template.format !== (ppt ? 'pptx' : 'docx')) throw new Error('양식과 완성 파일 형식이 다릅니다');
  }
  const review = metadata.review ? z.object({ content: z.boolean(), layout: z.boolean(), notes: z.string().optional() }).strict().parse(JSON.parse(metadata.review)) : null;
  if (review && (!review.content || !review.layout)) throw new Error('내용과 레이아웃 검수를 완료한 뒤 등록하세요');
  if (preparation && !review) throw new Error('작성 자료에 연결한 문서는 내용과 레이아웃 검수 결과가 필요합니다');
  const digest = hash(bytes);
  const old = await repo.one("SELECT * FROM artifacts WHERE conversation_id=? AND kind='document' AND hash=?", conversationId, digest);
  const record = async (artifact: any) => {
    ctx!.signal.throwIfAborted();
    if ((await repo.runStatus(runId))?.status !== 'running') throw new Error('종료되거나 중지된 조사 실행');
    if (preparation || review) await repo.artifact(conversationId, `reports/registrations/${randomUUID()}.json`, JSON.stringify({ artifactId: artifact.id, hash: digest, preparationId: preparation?.id || null, dataVersion: preparation?.revision ?? null, templateVersion: preparation?.templateVersion || null, rulesVersion: preparation?.rulesVersion || null, review, formatCheck: true }, null, 2), { runId, kind: 'report-registration', mime: 'application/json' });
    await repo.event(runId, 'artifact.published', { id: artifact.id, name: artifact.name, preparationId: preparation?.id || null, review, source: relative(repo.workspace(conversationId), file) });
    return download(artifact, conversationId);
  };
  if (old) return record(old);
  const name = basename(file).replace(/[^\p{L}\p{N}._ -]/gu, '_');
  // 도구가 나중에 원본을 수정하더라도 이 메시지의 다운로드 파일은 변하지 않게 보존한다.
  const artifact = await repo.artifact(conversationId, `reports/downloads/${randomUUID()}/${name}`, bytes, { runId, kind: 'document', mime: ppt ? POWERPOINT_MIME : WORD_MIME });
  return record(artifact);
}
function download(file: { id: string; name: string }, conversationId: string): ArtifactDownload {
  return { id: file.id, name: file.name.split('/').at(-1)!, url: `/api/conversations/${conversationId}/files/${file.id}` };
}

/** 문서 스킬이 검증 후 명시적으로 등록한 결과만 메시지에 연결한다. */
export async function collectDocuments(ctx: Execution): Promise<ArtifactDownload[]> {
  const { repo, conversationId, runId } = ctx;
  ctx.signal.throwIfAborted();
  const published = new Set((await repo.all("SELECT data FROM events WHERE run_id=? AND name='artifact.published'", runId)).map(event => JSON.parse(event.data).id));
  return (await repo.all("SELECT * FROM artifacts WHERE conversation_id=? AND kind='document'", conversationId)).filter(file => file.run_id === runId || published.has(file.id)).map(file => download(file, conversationId));
}
