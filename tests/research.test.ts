import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Repository, now, repository } from '../server/store';
import { executions } from '../server/execution';
import { researchTool, submitResearch } from '../server/research';
import { attach } from '../server/attachments';
import { app } from '../server/app';
import { startRun, stopRun, recoverRuns } from '../server/runs';
import { recentMessages, runTool } from '../server/agent';
import { chat } from '../server/gemma';
import { computeForecast } from '../shared/forecast';
import { contextMessages } from '../server/context';
import { zipSync, strToU8 } from 'fflate';

afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'radar-research-')), repo = new Repository(join(dir, 'db.sqlite'), dir);
  const conversation = await repo.createConversation(), runId = randomUUID(), controller = new AbortController();
  await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, conversation.id, 'test', 'running', now());
  return { repo, conversation, ctx: { repo, conversationId: conversation.id, runId, signal: controller.signal, env: {} }, controller };
}
async function payload(f: Awaited<ReturnType<typeof fixture>>) {
  const raw = structuredClone((await f.repo.data()).records.find(r => r.country === 'POL' && r.system === 'sph')!);
  const text = '검증용 가상 문서. 새 교체 계획은 2031년부터 2033년까지 10~12문이다.';
  const source: any = await researchTool('save_source', { url: 'https://example.org/test', content: text, kind: 'original', publishedAt: '2026-10-16' });
  raw.plan = { start: 2031, end: 2033, qty: [10, 12], text, src: ['test-source'] };
  raw.src.push('test-source');
  return { record: raw, expectedVersion: 1, reason: '가상 계획 검증', asOf: '2026-10-16', sources: { 'test-source': { ...source, status: undefined, t: '검증용', u: 'https://example.org/test', y: 2026 } }, evidence: [{ path: 'plan', sourceId: 'test-source', quote: text }] };
}
describe('SQLite 조사 반영', () => {
  it('수집→근거 검사→이력·예측 저장, 반복 반영·중복·버전 충돌 방지, 재시작 유지', async () => {
    const f = await fixture();
    await executions.run(f.ctx, async () => {
      const p = await payload(f);
      const result = await submitResearch(p);
      expect(result.ok).toBe(true); expect(result.forecast!.qty).toEqual([10,12]);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(1);
      expect(await f.repo.all('SELECT * FROM forecasts')).toHaveLength(1);
      await expect(submitResearch(p)).rejects.toThrow(/버전 충돌/);
      expect(await submitResearch({ ...p, expectedVersion: 2 })).toMatchObject({ unchanged: true });
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(1);
      const v2 = structuredClone(p); v2.expectedVersion = 2; v2.record.plan!.qty = [11,13];
      await expect(submitResearch({ ...v2, evidence: [{ ...v2.evidence[0], quote: '원문에 없는 인용' }] })).rejects.toThrow(/인용문/);
      expect((await f.repo.one('SELECT version FROM records WHERE id=?', p.record.id)).version).toBe(2);
      const second = new Repository(f.repo.file, f.repo.storage);
      expect((await second.data()).records.find(r => r.id === p.record.id)!.plan!.qty).toEqual([10,12]);
      await second.close();
    });
    await f.repo.close();
  });
  it('요약·원문 실패는 근거로 쓸 수 없고 변경 근거 없으면 롤백', async () => {
    const f = await fixture();
    await executions.run(f.ctx, async () => {
      const p = await payload(f);
      const search: any = await researchTool('save_source', { url: 'https://example.org/test', content: '요약만 있음', kind: 'search' });
      await expect(submitResearch({ ...p, sources: { 'test-source': { ...p.sources['test-source'], filePath: search.filePath, hash: search.hash } } })).rejects.toThrow(/원문 근거/);
      p.record.batches[0].qty += 1;
      await expect(submitResearch(p)).rejects.toThrow(/batches: 변경 근거/);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(0);
      expect(await f.repo.revision()).toBe(1);
    }); await f.repo.close();
  });
  it('단가·수명 가정 갱신은 전체 예측과 이력을 재계산하고 오래된 버전은 거절', async () => {
    const f = await fixture();
    await executions.run(f.ctx, async () => {
      const quote = '가상 검증: 자주포 설계 수명 40년, 단가 200~300억 원.';
      const source: any = await researchTool('save_source', { url: 'https://example.org/assumptions', content: quote, kind: 'original', publishedAt: '2026-10-16' });
      const system = { ...(await f.repo.data()).systems.sph, designLife: 40, unitCost: [200,300], costSrc: ['assumption-test'], unitCostEst: true };
      const payload = { expectedRevision: 1, systems: { sph: system }, sources: { 'assumption-test': { ...source, t: '가정 검증', u: 'https://example.org/assumptions', y: 2026 } }, evidence: [{ path: 'systems.sph', sourceId: 'assumption-test', quote }], reason: '검증용 가정 변경' };
      const result: any = await researchTool('update_assumptions', { payload: JSON.stringify(payload) });
      expect(result.ok).toBe(true); expect(result.recalculated).toBe(60); expect(await f.repo.revision()).toBe(2);
      const changed = JSON.parse((await f.repo.one('SELECT data FROM forecasts WHERE record_id=?', 'POL-sph')).data);
      expect(changed.after.qty).toEqual(changed.before.qty);
      expect(changed.after.krw).toEqual([changed.after.qty[0] * 200, changed.after.qty[1] * 300]);
      expect(changed.after.window[0]).toBe(changed.before.window[0] + 5);
      expect(await researchTool('update_assumptions', { payload: JSON.stringify(payload) })).toHaveProperty('error');
      expect(await f.repo.all('SELECT * FROM forecasts')).toHaveLength(60);
    }); await f.repo.close();
  });
  it('중지한 조사와 작업 폴더 밖 접근을 차단', async () => {
    const f = await fixture();
    await executions.run(f.ctx, async () => {
      const p = await payload(f);
      expect(() => f.repo.path(f.conversation.id, '../../.secrets')).toThrow();
      expect(await researchTool('workspace_write', { path: 'sources/rewrite.txt', content: 'x' })).toMatchObject({ error: expect.any(String) });
      await researchTool('workspace_write', { path: 'notes/check.txt', content: '첫 메모' });
      await researchTool('workspace_write', { path: 'notes/check.txt', content: '갱신 메모' });
      expect((await f.repo.conversation(f.conversation.id)).files.find((x: any) => x.name === 'notes/check.txt').kind).toBe('note');
      expect(readFileSync(f.repo.path(f.conversation.id, 'notes/check.txt', true), 'utf8')).toBe('갱신 메모');
      await f.repo.run("UPDATE runs SET status='stopping' WHERE id=?", f.ctx.runId);
      await expect(submitResearch(p)).rejects.toThrow(/중지/);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(0);
    }); await f.repo.close();
  });
  it('대화 삭제 후 조달 데이터·원문·조사 이력 보존', async () => {
    const f = await fixture();
    await executions.run(f.ctx, async () => {
      const p = await payload(f); await submitResearch(p);
      await f.repo.message(f.conversation.id, 'user', '자료 반영');
      await f.repo.run("UPDATE runs SET status='completed' WHERE id=?", f.ctx.runId);
      const file = f.repo.path(f.conversation.id, p.sources['test-source'].filePath, true);
      await f.repo.deleteConversation(f.conversation.id);
      expect(await f.repo.all('SELECT * FROM conversations')).toHaveLength(0);
      expect(await f.repo.all('SELECT * FROM messages')).toHaveLength(0);
      expect(await f.repo.all('SELECT * FROM changes')).toHaveLength(1);
      expect(existsSync(file)).toBe(true);
      expect((await f.repo.data()).records.find(r => r.id === p.record.id)!.plan).toBeDefined();
    }); await f.repo.close();
  });
  it('첨부 텍스트를 손실 없이 저장하고 대화끼리 격리', async () => {
    const f = await fixture();
    const file = await attach(f.repo, f.conversation.id, new File(['한글 첨부 문서'], '근거.txt', { type: 'text/plain' }));
    expect(readFileSync(f.repo.path(f.conversation.id, file.textPath, true), 'utf8')).toBe('한글 첨부 문서');
    const second = await f.repo.createConversation();
    expect((await f.repo.conversation(second.id)).files).toHaveLength(0);
    const repeated = await attach(f.repo, f.conversation.id, new File(['한글 첨부 문서'], '근거.txt', { type: 'text/plain' }));
    expect(repeated.id).toBe(file.id);
    await f.repo.close();
  });
  it('DOCX 문서·표 텍스트 추출과 잘못된 PDF 실패 표시', async () => {
    const f = await fixture();
    const bytes = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>한글 &amp; 근거</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>수량 12</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>') });
    const file = await attach(f.repo, f.conversation.id, new File([bytes], '근거.docx'));
    expect(file.extraction).toBe('ok');
    expect(readFileSync(f.repo.path(f.conversation.id, file.textPath, true), 'utf8')).toContain('한글 & 근거\n수량 12');
    const broken = await attach(f.repo, f.conversation.id, new File(['not a PDF'], '깨진.pdf', { type: 'application/pdf' }));
    expect(broken.extraction).toBe('failed');
    expect(existsSync(broken.path)).toBe(true);
    await f.repo.close();
  });
  it('텍스트 PDF 원본과 추출 텍스트 보존', async () => {
    const f = await fixture();
    const stream = 'BT /F1 12 Tf 30 100 Td (Attachment PDF evidence) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const start = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    const file = await attach(f.repo, f.conversation.id, new File([pdf], '근거.pdf', { type: 'application/pdf' }));
    expect(file.extraction).toBe('ok');
    expect(readFileSync(f.repo.path(f.conversation.id, file.textPath, true), 'utf8')).toContain('Attachment PDF evidence');
    await f.repo.close();
  });
  it('동향 기사만으로 계산 시점을 앞당기지 않음', async () => {
    const data = await repository().data(), r = data.records.find(r => r.country === 'POL' && r.system === 'sph')!;
    const plain = computeForecast({ ...r, signals: [] }, data);
    const noisy = computeForecast({ ...r, signals: Array.from({ length: 100 }, () => ({ year: 2026, text: '기사 언급', src: [] })) }, data);
    expect(noisy.window).toEqual(plain.window); expect(noisy.remaining).toBe(plain.remaining); expect(noisy.qty).toEqual(plain.qty);
  });
});

describe('영속 채팅·비동기 실행', () => {
  it('다른 살아 있는 서버 실행은 유지하고 종료된 프로세스의 실행만 복원 중단 표시', async () => {
    const repo = repository(), c = await repo.createConversation(), alive = randomUUID(), dead = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', alive, c.id, 'nemotron', 'running', now(), process.ppid);
    await recoverRuns(); expect((await repo.one('SELECT status FROM runs WHERE id=?', alive)).status).toBe('running');
    await repo.run("UPDATE runs SET status='completed' WHERE id=?", alive);
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at,owner_pid) VALUES(?,?,?,?,?,?)', dead, c.id, 'nemotron', 'running', now(), 2147483647);
    await recoverRuns(); expect((await repo.one('SELECT status FROM runs WHERE id=?', dead)).status).toBe('interrupted');
  });
  it('긴 기록을 순서대로 요약하고 원문·후속 메시지는 보존', async () => {
    const f = await fixture();
    const messages = Array.from({ length: 20 }, (_, i) => ({ role: 'user' as const, text: `${i}:` + '가'.repeat(4000) }));
    await executions.run(f.ctx, async () => {
      const inputs: string[] = [];
      const result = await contextMessages({ messages }, async prompt => { inputs.push(prompt); return '인계 요약'; });
      expect(inputs.join('\n')).toContain('0:'); expect(inputs.join('\n')).toContain('11:');
      expect(result.slice(-8)).toEqual(messages.slice(-8));
      expect(messages[0].text.length).toBe(4002);
      expect((await f.repo.one('SELECT covered FROM context_summaries')).covered).toBe(12);
    }); await f.repo.close();
  });
  it('긴 대화·도구 라운드·출력을 임의로 자르지 않음', async () => {
    const text = '가'.repeat(3000);
    expect(recentMessages({ messages: Array.from({ length: 20 }, () => ({ role: 'user', text })) })).toHaveLength(20);
    expect(recentMessages({ messages: [{ role: 'user', text }] })[0].text).toHaveLength(3000);
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      expect(JSON.parse(init.body).generationConfig.maxOutputTokens).toBeUndefined();
      return Response.json({ candidates: [{ content: { parts: ++n <= 5 ? [{ functionCall: { name: 'get_forecast', args: { country: '폴란드', system: '자주포' } } }] : [{ text }] } }] });
    }));
    expect((await chat({ messages: [{ role: 'user', text: '질문' }] }, { GOOGLE_API_KEY: 'fake' })).reply).toBe(text);
    expect(n).toBe(6);
  });
  it('API로 대화 선택·메시지 복원·첨부·삭제와 보고서 저장', async () => {
    const c = await (await app.request('/api/conversations', { method: 'POST' })).json();
    const form = new FormData(); form.append('files', new File(['시험 첨부'], '첨부.txt', { type: 'text/plain' }));
    expect((await app.request(`/api/conversations/${c.id}/files`, { method: 'POST', body: form })).status).toBe(201);
    const run = await startRun({ conversationId: c.id, messages: [{ role: 'user', text: '!보고서 폴란드 자주포' }] }, {});
    await run.done;
    const restored = await (await app.request(`/api/conversations/${c.id}`)).json();
    expect(restored.messages).toHaveLength(2); expect(restored.messages[1].reports[0]).toContain('### 6. 출처');
    const ref = restored.messages[1].reportRefs[0];
    expect(ref.country).toBe('POL'); expect(ref.system).toBe('sph');
    expect(ref.id).toBe((await repository().one('SELECT id FROM reports WHERE run_id=?', run.runId)).id);
    const repeated = await startRun({ conversationId: c.id, messages: [{ role: 'user', text: '!보고서 폴란드 자주포' }] }, {});
    await repeated.done;
    const again = await repository().conversation(c.id);
    expect(again.messages[3].reports[0]).toBe(restored.messages[1].reports[0]);
    expect(again.messages[3].reportRefs[0].id).not.toBe(ref.id);
    expect(again.messages[1].reportRefs[0].id).toBe(ref.id);
    expect(restored.runs[0].status).toBe('completed');
    expect((await repository().one('SELECT * FROM reports WHERE run_id=?', run.runId)).data_version).toBeGreaterThan(0);
    expect((await app.request(`/api/conversations/${c.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/conversations/${c.id}`)).status).toBe(404);
  });
  it('보고서 파일 저장 중 자료가 갱신되어도 생성에 사용한 버전을 보존한다', async () => {
    const f = await fixture(), revision = await f.repo.revision();
    const artifact = f.repo.artifact.bind(f.repo);
    const upload = vi.spyOn(f.repo, 'artifact').mockImplementationOnce(async (...args) => {
      await f.repo.run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
      return artifact(...args);
    });
    try {
      await executions.run(f.ctx, async () => {
        await runTool('write_report', { country: 'POL', system: 'sph' }, { reply: '', reports: [], actions: [], tools: [] });
      });
      expect((await f.repo.one('SELECT data_version FROM reports WHERE run_id=?', f.ctx.runId)).data_version).toBe(revision);
      expect(await f.repo.revision()).toBe(revision + 1);
    } finally { upload.mockRestore(); await f.repo.close(); }
  });
  it('추가 요청은 대기하고 대기 취소 및 실행 중지 시 원문과 상태를 보존', async () => {
    const repo = repository(), c = await repo.createConversation();
    let entered!: () => void;
    const ready = new Promise<void>(r => { entered = r; });
    vi.stubGlobal('fetch', vi.fn((_url: string, init: any) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted'))); entered();
    })));
    const input = { conversationId: c.id, messages: [{ role: 'user' as const, text: '조사해줘' }] };
    const run = await startRun(input, { GOOGLE_API_KEY: 'fake' });
    await ready;
    const queued = await startRun({ ...input, messages: [{ role: 'user', text: '다음 조사' }] }, {});
    expect((await repo.one('SELECT status FROM runs WHERE id=?', queued.runId)).status).toBe('queued');
    expect((await repo.conversation(c.id)).queued[0].text).toBe('다음 조사');
    await stopRun(queued.runId);
    expect((await repo.one('SELECT status FROM runs WHERE id=?', queued.runId)).status).toBe('cancelled');
    await stopRun(run.runId);
    expect((await repo.one('SELECT status FROM runs WHERE id=?', run.runId)).status).toBe('cancelled');
    expect((await repo.conversation(c.id)).messages.at(-1).text).toContain('중지');
  });
});
