import { describe, it, expect } from 'vitest';
import { repository } from '../server/store';
import { app } from '../server/app';
import { uploadedFiles, uploadedName } from '../src/chat-api';

/** 예전 ＋ 메뉴 목록 기준(기록·추출 텍스트만 숨김) */
const previous = (files: { kind: string }[]) => files.filter(f => f.kind !== 'tool-log' && f.kind !== 'extracted');
const byKind = (files: { kind: string }[]) => files.reduce<Record<string, number>>((n, f) => ({ ...n, [f.kind]: (n[f.kind] || 0) + 1 }), {});

describe('대화 자료 목록은 사용자가 올린 파일만', () => {
  it('업로드 원본만 보이고 추출본·수집 원문·보고서·생성 문서·기록은 숨긴다(자료와 작업 폴더는 그대로)', async () => {
    const repo = repository(), c = await repo.createConversation();
    const form = new FormData();
    form.append('files', new File(['첨부 원문'], '계약서.txt', { type: 'text/plain' }));
    form.append('files', new File([new Uint8Array([1, 2, 3])], '사진.png', { type: 'image/png' }));
    expect((await app.request(`/api/conversations/${c.id}/files`, { method: 'POST', body: form })).status).toBe(201);
    await app.request(`/api/conversations/${c.id}/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ country: 'POL' }) });
    for (const [name, kind] of [['sources/a.txt', 'original'], ['sources/a.original', 'raw-source'], ['sources/a.metadata.json', 'source-metadata'], ['sources/search-a.json', 'search'], ['notes/메모.txt', 'note'], ['analysis/a.json', 'analysis'], ['reports/prepared/a.json', 'report-packet'], ['reports/downloads/x/보고서.docx', 'document'], ['runs/a-codex.jsonl', 'tool-log']] as const)
      await repo.artifact(c.id, name, `${kind} 내용`, { kind });
    const files = (await (await app.request(`/api/conversations/${c.id}`)).json() as any).files;
    expect(byKind(files)).toEqual({ attachment: 2, extracted: 1, report: 1, original: 1, 'raw-source': 1, 'source-metadata': 1, search: 1, note: 1, analysis: 1, 'report-packet': 1, document: 1, 'tool-log': 1 });
    expect(previous(files)).toHaveLength(11);
    const shown = uploadedFiles(files);
    expect(shown.map((f: any) => uploadedName(f.name)).sort()).toEqual(['계약서.txt', '사진.png']);
    // 지우지 않고, 모델 작업 폴더 목록에는 모두 남는다
    expect(files).toHaveLength(13);
    expect(repo.files(c.id)).toEqual(expect.arrayContaining(['notes/메모.txt', 'sources/a.txt', 'reports/downloads/x/보고서.docx']));
    expect(repo.files(c.id).some(f => f.endsWith('계약서.txt.txt'))).toBe(true);
  });
});
