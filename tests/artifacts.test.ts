import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { repository, now } from '../server/store';
import { publishArtifact, collectDocuments, WORD_MIME } from '../server/artifacts';
import { researchTool } from '../server/research';
import { executions } from '../server/execution';
import { app } from '../server/app';

// 외부 문서 도구의 출력 파일을 모사한 테스트용 Word 패키지.
const document = (text: string) => zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`),
});
async function fixture() {
  const repo = repository(), c = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'codex', 'running', now());
  return { repo, c, controller, ctx: { repo, conversationId: c.id, runId, signal: controller.signal, env: {} } };
}
describe('CLI 완성 Word 파일의 등록, 다운로드', () => {
  it('MCP 등록 후 원본 바이트 그대로 다운로드, 대화 복원, 이후 수정된 원본과 분리', async () => {
    const { repo, c, ctx } = await fixture();
    const path = repo.path(c.id, 'reports/사업기회.docx'), bytes = document('가상 사업기회 검증');
    writeFileSync(path, bytes);
    const file: any = await executions.run(ctx, () => researchTool('publish_artifact', { path }));
    expect(file.url).toMatch(new RegExp(`/api/conversations/${c.id}/files/`));
    const response = await app.request(file.url);
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe(WORD_MIME);
    expect(decodeURIComponent(response.headers.get('content-disposition')!)).toContain('사업기회.docx');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(bytes));
    await repo.message(c.id, 'model', '보고서를 작성했습니다', { files: [file] });
    expect((await (await app.request(`/api/conversations/${c.id}`)).json()).messages[0].files[0].id).toBe(file.id);
    writeFileSync(path, document('수정 후'));
    expect(readFileSync((await repo.one('SELECT path FROM artifacts WHERE id=?', file.id)).path)).toEqual(Buffer.from(bytes));
    expect(await collectDocuments(ctx)).toHaveLength(1);
    await publishArtifact('reports/사업기회.docx', ctx);
    expect(await collectDocuments(ctx)).toHaveLength(2);
    expect(await collectDocuments(ctx)).toHaveLength(2);
    const snapshotPath=(await repo.one('SELECT path FROM artifacts WHERE id=?',file.id)).path;
    writeFileSync(snapshotPath,'변조된 다운로드 파일');
    expect((await app.request(file.url)).status).toBe(400);
    writeFileSync(snapshotPath,bytes);
  });
  it('새 실행에서 이전 파일을 자동 첨부하지 않고 명시적 재등록은 중복 없이 연결', async () => {
    const { repo, c, ctx } = await fixture();
    writeFileSync(repo.path(c.id, 'reports/이전.docx'), document('이전 문서'));
    const first = await publishArtifact('reports/이전.docx', ctx);
    await repo.run("UPDATE runs SET status='completed' WHERE id=?", ctx.runId);
    const runId = randomUUID(); await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'grok', 'running', now());
    const next = { ...ctx, runId };
    expect(await collectDocuments(next)).toEqual([]);
    expect((await publishArtifact('reports/이전.docx', next)).id).toBe(first.id);
    expect(await collectDocuments(next)).toEqual([first]);
  });
  it('작업 폴더 밖, 다른 대화, 잘못된 파일과 중지된 실행은 등록 불가', async () => {
    const { repo, c, ctx, controller } = await fixture();
    const other = await repo.createConversation();
    const path = repo.path(other.id, 'reports/다른.docx'); writeFileSync(path, document('다른 대화'));
    await expect(publishArtifact(path, ctx)).rejects.toThrow(/작업 폴더 밖/);
    writeFileSync(repo.path(c.id, 'reports/broken.docx'), '가짜 파일');
    await expect(publishArtifact('reports/broken.docx', ctx)).rejects.toThrow();
    writeFileSync(repo.path(c.id, 'reports/plain.txt'), '일반 텍스트');
    await expect(publishArtifact('reports/plain.txt', ctx)).rejects.toThrow(/docx/);
    mkdirSync(dirname(repo.path(c.id, 'reports/valid.docx')), { recursive: true });
    writeFileSync(repo.path(c.id, 'reports/valid.docx'), document('정상'));
    const file = await publishArtifact('reports/valid.docx', ctx);
    expect((await app.request(file.url.replace(c.id, other.id))).status).toBe(404);
    controller.abort(); await expect(publishArtifact('reports/valid.docx', ctx)).rejects.toThrow();
  });
});
