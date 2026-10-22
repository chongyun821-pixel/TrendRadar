import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { computeForecast, SOURCE_CONFIDENCE } from '../shared/forecast';
import { resolveCountry, resolveSystem } from '../shared/data';
import type { ProgramRecord, Seed } from '../shared/types';
import { SYSTEM_KEYS, SIGNAL_STAGES } from '../shared/types';
import { execution } from './execution';
import { PROJECT_ROOT, now, hash } from './store';
import type { ToolDef } from './agent';
import { publishArtifact } from './artifacts';
import { upsertRows } from './collection';
import { scoreCase } from './scoring';
import type { Repository } from './store';
import type { SignalRow } from '../shared/types';

const str = (description: string) => ({ type: 'string' as const, description });
export const RESEARCH_DEFS: ToolDef[] = [
  { name: 'research_procurement', description: '조사 준비: 최신 SQL record/version·양식·누락·작업 폴더·기존 자료 반환', properties: { country: str('국가명/ISO3'), system: str('무기체계') }, required: ['country', 'system'] },
  { name: 'save_source', description: '기본 웹 도구로 읽은 원문·검색 요약 또는 수집 실패를 운영 SQL·파일 저장소에 보존', properties: { url: str('원문 URL'), content: str('도구로 실제 읽은 전체 내용'), title: str('제목'), publishedAt: str('발행일 ISO 또는 빈 문자열'), kind: str('original 또는 search'), status: str('ok 또는 failed'), error: str('실패 이유') }, required: ['url', 'content', 'kind'] },
  { name: 'workspace_list', description: '현재 대화의 파일 전체 목록', properties: {} },
  { name: 'publish_artifact', description: '기존 문서 도구로 작성하고 검수한 워드 또는 파워포인트 완성 파일의 사본과 다운로드를 보존한다', properties: { path: str('대화 작업 폴더 안의 완성된 .docx 또는 .pptx 경로'), preparationId: str('prepare_report가 반환한 작성 자료 ID'), review: str('실제 검수 결과 JSON: content, layout(boolean), notes?') }, required: ['path'] },
  { name: 'source_read', description: 'SQL 출처 ID로 보존 원문 재조회. 대화 삭제 후에도 조회 가능. 큰 파일은 offset/length로 이어 읽기', properties: { sourceId: str('출처 ID'), offset: { type: 'integer' }, length: { type: 'integer' } }, required: ['sourceId'] },
  { name: 'workspace_read', description: '대화 작업 파일 읽기. 큰 파일은 offset/length로 이어 읽기', properties: { path: str('상대경로'), offset: { type: 'integer' }, length: { type: 'integer' } }, required: ['path'] },
  { name: 'workspace_write', description: '조사 메모·분석 파일 작성·수정. 원문과 첨부는 수정 불가', properties: { path: str('notes/ 또는 analysis/ 상대경로'), content: str('파일 전체 내용') }, required: ['path', 'content'] },
  { name: 'submit_research', description: '조사 양식 검사 후 근거·변경 이력·예측을 원자적으로 저장. 충돌 시 반영하지 않음', properties: { payload: str('research_procurement 양식에 따른 JSON') }, required: ['payload'] },
  { name: 'update_assumptions', description: '단가·수명·환율 가정 변경. 모든 예측 재계산. 출처와 추정 표시 유지', properties: { payload: str('JSON: expectedRevision, systems?(부분 아닌 체계 메타 전체), fx?, reason, evidence[{path,sourceId,quote}], sources') }, required: ['payload'] },
  { name: 'research_history', description: '기존 조사·변경 전후·예측 이력 조회', properties: { country: str('국가명/ISO3'), system: str('체계') } },
  { name: 'conversation_read', description: '저장된 전체 대화·보고서에서 검색·재조회', properties: { query: str('포함 문자열, 생략하면 전체'), offset: { type: 'integer' }, limit: { type: 'integer' } } },
  { name: 'firecrawl_search', description: '지피티·네모트론용 Firecrawl MCP 웹 검색. 요약은 원문과 구분해 저장', properties: { query: str('검색어') }, required: ['query'] },
  { name: 'firecrawl_scrape', description: '지피티·네모트론용 Firecrawl MCP 원문 HTML/PDF 읽기 및 보존', properties: { url: str('원문 URL') }, required: ['url'] },
];

const refs = z.array(z.string());
const est = refs.optional();
const year = z.number().int().min(1800).max(2300);
const count = z.number().nonnegative();
const range = z.tuple([count, count]).refine(a => a[0] <= a[1], '범위 순서 오류');
const batch = z.object({ model: z.string().min(1), introYear: year, qty: count, lifeExt: count.optional(), covered: z.boolean().optional(), est, note: z.string().optional(), src: refs });
export const recordSchema = z.object({
  id: z.string().min(1), country: z.string().regex(/^[A-Z]{3}$/), system: z.enum(SYSTEM_KEYS), batches: z.array(batch), src: refs,
  awarded: z.object({ year, text: z.string(), qty: count, deliveryEnd: year, covers: z.number().min(0).max(1), est, src: refs }).optional(),
  plan: z.object({ start: year, end: year, qty: range, text: z.string(), est, src: refs }).refine(p => p.start <= p.end).optional(),
  mro: z.array(z.object({ year, text: z.string(), lifeExt: count, est, src: refs })).optional(),
  signals: z.array(z.object({ year, text: z.string(), src: refs })).optional(), ratio: range.refine(r => r[1] <= 1).optional(), ratioEst: z.boolean().optional(),
  projects: z.array(z.object({ id: z.string().min(1), buyer: z.string(), supplier: z.string(), stage: z.enum(['consideration','plan','tender','contract','delivery','cancelled']), text: z.string(), qty: count.optional(), amount: count.optional(), currency: z.string().optional(), src: refs })).optional(),
  analysis: z.object({ facts: refs, estimates: refs, conflicts: refs, unknowns: refs, opportunity: z.string().optional() }).optional(),
}).strict();
const publishedDate = z.union([z.string().date(), z.string().datetime({ offset: true })]);
const sourceSchema = z.object({ t: z.string().min(1), u: z.string().url(), y: z.number().int().min(0).max(2300), publishedAt: publishedDate.nullable().optional(), collectedAt: z.string().datetime({ offset: true }), filePath: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), kind: z.enum(['original','attachment']), excerpt: z.string().optional() });
const evidenceSchema = z.array(z.object({ path: z.string(), sourceId: z.string(), quote: z.string().min(1) })).min(1);
const countrySchema = z.object({ ko: z.string().min(1), flag: z.string(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
/** 조사 결과의 signals 추출 형식(템플릿 'signals 추출'). 행마다 원문 인용이 있어야 하며 signals 표에 upsert된다 */
export const signalRowSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/), stage: z.enum(SIGNAL_STAGES),
  model: z.string().optional(), maker: z.string().optional(), supplier: z.string().optional(), quantity: count.optional(), value_usd_m: count.optional(), expected_year: year.optional(),
  published_at: publishedDate.nullable().optional(), sourceType: z.enum(['official', 'specialist', 'news']), sourceId: z.string().min(1), quote: z.string().min(1), note: z.string().max(500).optional(),
}).strict();
export const submissionSchema = z.object({ record: recordSchema, signalRows: z.array(signalRowSchema).max(50).optional(), expectedVersion: z.number().int().nonnegative(), sources: z.record(sourceSchema), evidence: evidenceSchema, reason: z.string().min(1), asOf: z.string().date(), countryMeta: countrySchema.optional(), rulesVersion: z.literal('normalization-v1').optional() }).strict();

async function sourcesChecked(sources: Record<string, z.infer<typeof sourceSchema>>, evidence: z.infer<typeof evidenceSchema>) {
  const ctx = await execution();
  const texts: Record<string, string> = {};
  for (const [id, s] of Object.entries(sources)) {
    const file = await ctx.repo.ensureFile(ctx.repo.path(ctx.conversationId, s.filePath));
    const artifact = await ctx.repo.one('SELECT * FROM artifacts WHERE path=? AND conversation_id=?', ctx.repo.storedPath(file), ctx.conversationId);
    if (!artifact || !['original','attachment','extracted'].includes(artifact.kind) || artifact.status !== 'ok' || (artifact.url && artifact.url !== s.u)) throw new Error(`${id}: 저장된 원문 근거가 아님`);
    const bytes = readFileSync(file);
    if (hash(bytes) !== s.hash || artifact.hash !== s.hash) throw new Error(`${id}: 원문 해시 불일치`);
    if (s.collectedAt !== artifact.collected_at) throw new Error(`${id}: 수집 시각 불일치`);
    texts[id] = bytes.toString('utf8');
    if (s.publishedAt && Number(s.publishedAt.slice(0, 4)) !== s.y) throw new Error(`${id}: 발행 연도 불일치`);
    if (!s.publishedAt && s.y !== 0) throw new Error(`${id}: 발행일 미확인은 y=0`);
  }
  for (const e of evidence) {
    if (!texts[e.sourceId]) {
      const source = (await ctx.repo.data()).sources[e.sourceId];
      const artifact = source?.hash && await ctx.repo.one("SELECT * FROM artifacts WHERE hash=? AND name=? AND status='ok' AND kind IN ('original','attachment','extracted')", source.hash, source.filePath || '');
      if (artifact) {
        const bytes = readFileSync(await ctx.repo.ensureFile(artifact.path));
        if (hash(bytes) !== source.hash) throw new Error('보존 원문 해시 불일치');
        texts[e.sourceId] = bytes.toString('utf8');
      }
    }
    if (!texts[e.sourceId]?.includes(e.quote)) throw new Error(`${e.path}: 저장 원문에 인용문이 없음`);
  }
}
/** 공급국 표기 → ISO3. 한국은 그룹사 판정(supplier='KOR')에 쓰이므로 한·영 표기를 모두 받는다 */
const KOREA = /^(kor|korea|south korea|republic of korea|rok|대한민국|한국)$/i;
export const supplierId = (s?: string) => s == null ? undefined : KOREA.test(s.trim()) ? 'KOR' : resolveCountry(s) ?? (/^[A-Z]{3}$/.test(s.trim()) ? s.trim() : s);
const signalEvidence = (rows: z.infer<typeof signalRowSchema>[] = []) => rows.map((r, i) => ({ path: `signalRows.${i}`, sourceId: r.sourceId, quote: r.quote }));
/** signals 추출 행 → signals 표. 신뢰도는 출처 유형(공식 1.0, 전문 0.7, 뉴스 0.4), 수집일은 출처의 collectedAt */
async function applySignalRows(repo: Repository, rec: ProgramRecord, rows: z.infer<typeof signalRowSchema>[], sources: Seed['sources'], date: string) {
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('중복 signalRows ID');
  for (const r of rows) if (!sources[r.sourceId]) throw new Error(`signalRows: 없는 출처 ${r.sourceId}`);
  return upsertRows(repo, 'signals', rows.map((r): Partial<SignalRow> => ({
    id: `research:${rec.country}:${rec.system}:${r.id}`, country: rec.country, system: rec.system, model: r.model, maker: r.maker, supplier: supplierId(r.supplier),
    stage: r.stage, quantity: r.quantity, value_usd_m: r.value_usd_m, expected_year: r.expected_year, published_at: r.published_at ?? null, url: sources[r.sourceId].u,
    note: r.note ?? r.quote.slice(0, 300), source_id: r.sourceId, confidence: SOURCE_CONFIDENCE[r.sourceType], collected_at: sources[r.sourceId].collectedAt || date,
  })));
}
function sourceIds(rec: ProgramRecord): string[] {
  return [...rec.src, ...rec.batches.flatMap(b => b.src), ...(rec.awarded?.src || []), ...(rec.plan?.src || []), ...(rec.mro || []).flatMap(x => x.src), ...(rec.signals || []).flatMap(x => x.src), ...(rec.projects || []).flatMap(x => x.src)];
}
export async function submitResearch(raw: unknown, options: { dryRun?: boolean; idempotent?: boolean } = {}) {
  const ctx = await execution(), repo = ctx.repo;
  const p = submissionSchema.parse(raw), rec = p.record;
  await sourcesChecked(p.sources, [...p.evidence, ...signalEvidence(p.signalRows)]);
  const projects = rec.projects || [];
  if (new Set(projects.map(x => x.id)).size !== projects.length) throw new Error('중복 사업 ID');
  if (projects.some(x => x.buyer !== rec.country)) throw new Error('사업 구매국은 record.country ISO3와 같아야 합니다');
  return await repo.transaction(async () => {
    await execution();
    ctx.signal.throwIfAborted();
    await sourcesChecked(p.sources, [...p.evidence, ...signalEvidence(p.signalRows)]);
    const old = await repo.one('SELECT * FROM records WHERE country=? AND system=?', rec.country, rec.system);
    const collision = await repo.one('SELECT country,system FROM records WHERE id=?', rec.id);
    if (collision && (collision.country !== rec.country || collision.system !== rec.system)) throw new Error('다른 국가·체계에서 쓰는 record ID');
    if ((old?.version || 0) !== p.expectedVersion) {
      const previous = options.idempotent && await repo.one('SELECT data FROM research WHERE record_id=? ORDER BY rowid DESC LIMIT 1', rec.id);
      if (old?.version === p.expectedVersion + 1 && old.data === JSON.stringify(rec) && previous?.data === JSON.stringify(p)) return { ok: true, unchanged: true, version: old.version };
      throw new Error('데이터 버전 충돌: 재조회 후 제출');
    }
    if (old && old.id !== rec.id) throw new Error('기존 record ID 유지 필요');
    const before = old ? JSON.parse(old.data) : null;
    const oldProjects = before?.projects || [];
    const cancelled = projects.filter(x => x.stage === 'cancelled' && oldProjects.some((p: any) => p.id === x.id && p.stage !== 'cancelled'));
    if (cancelled.length && ((before?.awarded && JSON.stringify(before.awarded) === JSON.stringify(rec.awarded)) || (before?.plan && JSON.stringify(before.plan) === JSON.stringify(rec.plan)))) throw new Error('취소 사업의 awarded/plan 계산 입력을 재검토·정정하세요');
    const changed = [...new Set([...Object.keys(before || {}), ...Object.keys(rec)])].filter(k => JSON.stringify(before?.[k]) !== JSON.stringify((rec as any)[k]));
    if (!changed.length) {
      // 기록은 그대로이고 signals 추출 행만 있으면 출처를 검사해 signals 표만 갱신한다
      if (p.signalRows?.length) {
        const known = (await repo.data()).sources;
        for (const [id, s] of Object.entries(p.sources)) if (known[id] && (known[id].u !== s.u || (known[id].hash && known[id].hash !== s.hash))) throw new Error('기존 출처 ID 덮어쓰기 금지. 새 버전 ID 사용');
        for (const r of p.signalRows) if (!known[r.sourceId] && !p.sources[r.sourceId]) throw new Error(`signalRows: 없는 출처 ${r.sourceId}`);
        if (options.dryRun) return { ok: true, unchanged: true, valid: true, signalRows: p.signalRows.length, version: old.version, rulesVersion: p.rulesVersion || 'normalization-v1', semanticReviewRequired: true };
        for (const [id, s] of Object.entries(p.sources)) await repo.run('INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', id, JSON.stringify(s));
        return { ok: true, unchanged: true, version: old.version, signals: await applySignalRows(repo, rec, p.signalRows, { ...known, ...p.sources }, now()) };
      }
      return { ok: true, unchanged: true, version: old.version, ...(options.dryRun ? { valid: true, rulesVersion: p.rulesVersion || 'normalization-v1', semanticReviewRequired: true } : {}) };
    }
    for (const field of changed.filter(k => !['id','country','system','src'].includes(k))) if (!p.evidence.some(e => e.path === field || e.path.startsWith(`${field}.`))) throw new Error(`${field}: 변경 근거 누락`);
    const data = await repo.data();
    if (data.countries[rec.country] && p.countryMeta && JSON.stringify(data.countries[rec.country]) !== JSON.stringify(p.countryMeta)) throw new Error('countryMeta는 신규 국가에만 사용하세요');
    if (!data.countries[rec.country] && !p.countryMeta) throw new Error('새 국가의 countryMeta 필요');
    const allSources = { ...data.sources, ...p.sources };
    for (const id of sourceIds(rec)) if (!allSources[id]) throw new Error(`없는 출처 ${id}`);
    for (const e of p.evidence) if (!sourceIds(rec).includes(e.sourceId)) throw new Error('변경 근거를 record src에도 연결하세요');
    for (const r of p.signalRows || []) if (!allSources[r.sourceId]) throw new Error(`signalRows: 없는 출처 ${r.sourceId}`);
    if (options.dryRun) return { ok: true, valid: true, changed, expectedVersion: p.expectedVersion, rulesVersion: 'normalization-v1', semanticReviewRequired: true, ...(p.signalRows ? { signalRows: p.signalRows.length } : {}) };
    if (p.countryMeta && !data.countries[rec.country]) await repo.run('INSERT INTO countries(id,data) VALUES (?,?)', rec.country, JSON.stringify(p.countryMeta));
    for (const [id, s] of Object.entries(p.sources)) {
      const existing = data.sources[id];
      if (existing && (existing.u !== s.u || (existing.hash && existing.hash !== s.hash))) throw new Error('기존 출처 ID 덮어쓰기 금지. 새 버전 ID 사용');
      await repo.run('INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', id, JSON.stringify(s));
    }
    const version = (old?.version || 0) + 1, date = now();
    const snapshot: Seed = { ...data, countries: { ...data.countries, ...(p.countryMeta ? { [rec.country]: p.countryMeta } : {}) }, sources: allSources };
    const previousForecast = before ? computeForecast(before, data) : null;
    const forecast = computeForecast(rec, snapshot);
    await repo.run('INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,version=excluded.version,updated_at=excluded.updated_at', rec.id, rec.country, rec.system, JSON.stringify(rec), version, date);
    await repo.run('INSERT INTO changes(record_id,run_id,before_data,after_data,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?)', rec.id, ctx.runId, before ? JSON.stringify(before) : null, JSON.stringify(rec), p.reason, JSON.stringify(p.evidence), date);
    await repo.run('INSERT INTO research VALUES(?,?,?,?,?,?)', randomUUID(), ctx.runId, rec.id, p.rulesVersion ? `research-v1/${p.rulesVersion}` : 'v1', JSON.stringify(p), date);
    const signals = p.signalRows?.length ? await applySignalRows(repo, rec, p.signalRows, allSources, date) : 0;
    // 판단 점수(항목별 점수·근거 ID)를 예측과 함께 보존해 리포트에서 인용한다
    const score = await scoreCase(repo, { ...snapshot, records: [...data.records.filter(r => r.id !== rec.id), rec] }, rec.country, rec.system);
    await repo.run('INSERT INTO forecasts(record_id,run_id,data_version,data,computed_at) VALUES(?,?,?,?,?)', rec.id, ctx.runId, await repo.revision() + 1, JSON.stringify({ before: previousForecast, after: forecast, score }), date);
    await repo.run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
    const meta = { ...data.meta, collected: date };
    await repo.run("UPDATE metadata SET value=? WHERE key='meta'", JSON.stringify(meta));
    return { ok: true, version, changed, previousForecast, forecast, score: { score: score.score, grey: score.grey, gate: score.gate.reason, evidenceIds: score.evidenceIds }, signals, reason: p.reason };
  }, ctx.signal);
}

async function firecrawl(name: string, a: Record<string, any>) {
  const ctx = await execution();
  if (!ctx.env.FIRECRAWL_API_KEY?.trim()) throw new Error('FIRECRAWL_API_KEY를 .secrets에 입력하세요');
  const client = new Client({ name: 'procurement-radar', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(ctx.env.FIRECRAWL_MCP_URL || 'https://mcp.firecrawl.dev/v2/mcp'), { requestInit: { headers: { Authorization: `Bearer ${ctx.env.FIRECRAWL_API_KEY.trim()}` }, signal: ctx.signal } });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some(t => t.name === name)) throw new Error(`Firecrawl MCP 도구 없음: ${name}`);
    const result = await client.callTool({ name, arguments: name === 'firecrawl_search' ? { query: a.query } : { url: a.url, formats: ['markdown'] } }, undefined, { signal: ctx.signal, resetTimeoutOnProgress: true });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    const raw = result.structuredContent || result.content;
    const unwrap = (value: any): any => {
      if (Array.isArray(value)) return value.map(unwrap);
      if (value?.type === 'text' && typeof value.text === 'string') { try { return JSON.parse(value.text); } catch { return value.text; } }
      return value;
    };
    const decoded = unwrap(raw);
    const textOf = (value: any): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(textOf).filter(Boolean).join('\n\n') : value?.markdown || value?.data?.markdown || value?.html || value?.data?.html || '';
    const content = name === 'firecrawl_search' ? JSON.stringify(raw, null, 2) : textOf(decoded);
    if (!content.trim()) throw new Error('Firecrawl 응답에 읽을 수 있는 원문이 없습니다');
    await ctx.repo.artifact(ctx.conversationId, `runs/${randomUUID()}-firecrawl.json`, JSON.stringify(raw, null, 2), { runId: ctx.runId, kind: 'tool-log', mime: 'application/json' });
    const artifact = await ctx.repo.artifact(ctx.conversationId, `sources/${randomUUID()}.txt`, content, { runId: ctx.runId, kind: name === 'firecrawl_search' ? 'search' : 'original', url: a.url, mime: 'text/plain' });
    return { ...(name === 'firecrawl_search' ? { result: raw } : { totalChars: content.length, nextStep: 'workspace_read로 저장된 원문을 읽으세요. offset/length로 이어 읽을 수 있습니다.' }), filePath: artifact.name, hash: artifact.hash, collectedAt: artifact.collected_at, publishedAt: null, kind: artifact.kind };
  } catch (e) {
    await ctx.repo.artifact(ctx.conversationId, `sources/failure-${randomUUID()}.txt`, String(e).replaceAll(ctx.env.FIRECRAWL_API_KEY, '[redacted]'), { runId: ctx.runId, kind: 'failure', url: a.url, status: 'failed', error: 'Firecrawl 수집 실패' });
    throw new Error('Firecrawl 수집 실패. 실행 기록을 확인하세요');
  } finally { await client.close().catch(() => {}); }
}

export async function researchTool(name: string, a: Record<string, any>): Promise<unknown> {
  const ctx = await execution(), repo = ctx.repo, id = ctx.conversationId;
  await repo.data();
  await repo.prepareWorkspace(id);
  ctx.signal.throwIfAborted();
  await repo.event(ctx.runId, 'tool.start', { name, args: a });
  try {
    let result: unknown;
    switch (name) {
      case 'research_procurement': {
        const country = resolveCountry(a.country) || String(a.country).toUpperCase(), system = resolveSystem(a.system);
        if (!system) throw new Error('무기체계 확인 필요');
        const row = await repo.one('SELECT * FROM records WHERE country=? AND system=?', country, system);
        result = { country, system, record: row ? JSON.parse(row.data) : { id: `${country}_${system}`, country, system, batches: [], src: [] }, expectedVersion: row?.version || 0, expectedRevision: await repo.revision(), assumptions: (await repo.data()).systems[system], meta: (await repo.data()).meta, templateVersion: 'v1', template: readFileSync(join(PROJECT_ROOT, 'templates/research-v1.md'), 'utf8'), rulesVersion: 'normalization-v1', rules: readFileSync(join(PROJECT_ROOT, 'templates/normalization-v1.md'), 'utf8'), sourceSearchCoverage: '인증키 없는 GOV.UK 공개 검색과 기존 보존 출처. 다른 국가의 자료는 기존 웹 도구로 보완한다.', workspace: repo.workspace(id), files: repo.files(id), lastResearch: await repo.one('SELECT * FROM research WHERE record_id=? ORDER BY rowid DESC LIMIT 1', row?.id || ''), missing: row ? ['발행일 미확인 출처', '추정 표시 필드', 'analysis.unknowns를 검토하세요'] : ['보유·사업·출처·국가 좌표'] };
        break;
      }
      case 'save_source': {
        z.string().url().parse(a.url);
        if (!['original','search'].includes(a.kind)) throw new Error('kind는 original 또는 search');
        const content = z.string().parse(a.content);
        if (!content && a.status !== 'failed') throw new Error('빈 원문');
        const artifact = await repo.artifact(id, `sources/${randomUUID()}.txt`, content, { runId: ctx.runId, kind: a.kind, url: a.url, publishedAt: a.publishedAt || null, status: a.status === 'failed' ? 'failed' : 'ok', error: a.error });
        result = { filePath: artifact.name, hash: artifact.hash, collectedAt: artifact.collected_at, publishedAt: artifact.published_at, kind: artifact.kind, status: artifact.status };
        break;
      }
      case 'workspace_list': result = repo.files(id).map(path => ({ path, bytes: statSync(repo.path(id, path, true)).size })); break;
      case 'publish_artifact': result = await publishArtifact(z.string().min(1).parse(a.path), ctx, { preparationId: a.preparationId, review: a.review }); break;
      case 'source_read': {
        const source = (await repo.data()).sources[a.sourceId];
        const artifact = source?.hash && await repo.one("SELECT * FROM artifacts WHERE hash=? AND name=? AND status='ok' AND kind IN ('original','attachment','extracted')", source.hash, source.filePath || '');
        if (!artifact) throw new Error('보존한 원문 없음. 최초 이관 자료는 URL에서 원문을 새로 수집하세요');
        const bytes = readFileSync(await repo.ensureFile(artifact.path));
        if (hash(bytes) !== source.hash) throw new Error('원문 해시 불일치');
        const text = bytes.toString('utf8'), offset = z.number().int().nonnegative().parse(a.offset ?? 0), length = z.number().int().positive().parse(a.length ?? Math.max(1, text.length));
        result = { source, text: text.slice(offset, offset + length), total: text.length, nextOffset: offset + length < text.length ? offset + length : null }; break;
      }
      case 'workspace_read': {
        const content = readFileSync(await repo.ensureFile(repo.path(id, z.string().parse(a.path))), 'utf8');
        const offset = z.number().int().nonnegative().parse(a.offset ?? 0), length = z.number().int().positive().parse(a.length ?? Math.max(1, content.length));
        result = { text: content.slice(offset, offset + length), total: content.length, nextOffset: offset + length < content.length ? offset + length : null };
        break;
      }
      case 'workspace_write': {
        if (!/^(notes|analysis)\//.test(a.path) || a.path.split(/[\\/]/).some((p: string) => p === '..' || p.startsWith('.'))) throw new Error('notes/·analysis/ 안의 일반 파일만 작성 가능');
        const path = repo.path(id, a.path);
        const { mkdirSync, writeFileSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        const content = z.string().parse(a.content);
        const old = await repo.one('SELECT * FROM artifacts WHERE path=?', repo.storedPath(path));
        if (old) {
          if (!['note','analysis'].includes(old.kind)) throw new Error('원문·첨부·보고서는 이 도구로 수정할 수 없습니다');
          mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
          await repo.syncFile(path);
          await repo.run('UPDATE artifacts SET hash=?,run_id=?,collected_at=? WHERE id=?', hash(content), ctx.runId, now(), old.id);
        } else await repo.artifact(id, a.path, content, { runId: ctx.runId, kind: a.path.startsWith('analysis/') ? 'analysis' : 'note', mime: 'text/plain' });
        result = { path: a.path }; break;
      }
      case 'submit_research': result = await submitResearch(JSON.parse(a.payload)); break;
      case 'update_assumptions': {
        const p = z.object({ expectedRevision: z.number().int(), systems: z.record(z.object({ ko: z.string(), unit: z.string(), designLife: z.number().positive(), unitCost: range, unitCostEst: z.boolean(), unitCostBasis: z.string(), costSrc: refs, hanwha: refs })).optional(), fx: z.record(z.union([z.string(), z.number()])).optional(), sources: z.record(sourceSchema), evidence: evidenceSchema, reason: z.string().min(1) }).strict().parse(JSON.parse(a.payload));
        await sourcesChecked(p.sources, p.evidence);
        result = await repo.transaction(async () => {
          await execution();
          if (await repo.revision() !== p.expectedRevision) throw new Error('데이터 버전 충돌');
          const data = await repo.data();
          for (const k of Object.keys(p.systems || {})) { if (!data.systems[k as keyof Seed['systems']]) throw new Error('지원하지 않는 무기체계'); if (!p.evidence.some(e => e.path === `systems.${k}` || e.path.startsWith(`systems.${k}.`))) throw new Error('체계 변경 근거 누락'); }
          if (p.fx && !p.evidence.some(e => e.path === 'fx' || e.path.startsWith('fx.'))) throw new Error('환율 변경 근거 누락');
          for (const [key, value] of Object.entries(p.sources)) { const old = data.sources[key]; if (old && JSON.stringify(old) !== JSON.stringify(value)) throw new Error('출처 ID 덮어쓰기 금지'); await repo.run('INSERT OR IGNORE INTO sources VALUES (?,?)', key, JSON.stringify(value)); }
          const sources = { ...data.sources, ...p.sources };
          for (const [key, value] of Object.entries(p.systems || {})) { for (const source of value.costSrc) if (!sources[source]) throw new Error('단가 출처 누락'); await repo.run('UPDATE systems SET data=? WHERE id=?', JSON.stringify(value), key); }
          const next = { ...data, sources, systems: { ...data.systems, ...p.systems }, meta: { ...data.meta, fx: { ...data.meta.fx, ...p.fx }, collected: now() } };
          await repo.run("UPDATE metadata SET value=? WHERE key='meta'", JSON.stringify(next.meta));
          await repo.run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
          await repo.run('INSERT INTO changes(record_id,run_id,before_data,after_data,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?)', '@assumptions', ctx.runId, JSON.stringify({ systems: data.systems, fx: data.meta.fx }), JSON.stringify({ systems: next.systems, fx: next.meta.fx }), p.reason, JSON.stringify(p.evidence), now());
          for (const rec of data.records) await repo.run('INSERT INTO forecasts(record_id,run_id,data_version,data,computed_at) VALUES(?,?,?,?,?)', rec.id, ctx.runId, await repo.revision(), JSON.stringify({ before: computeForecast(rec, data), after: computeForecast(rec, next) }), now());
          return { ok: true, revision: await repo.revision(), recalculated: data.records.length };
        }, ctx.signal); break;
      }
      case 'research_history': {
        const c = resolveCountry(a.country), s = resolveSystem(a.system);
        const ids = (await repo.data()).records.filter(r => (!c || r.country === c) && (!s || r.system === s)).map(r => r.id);
        result = { changes: (await repo.all('SELECT * FROM changes ORDER BY id DESC')).filter(r => ids.includes(r.record_id)), forecasts: (await repo.all('SELECT * FROM forecasts ORDER BY id DESC')).filter(r => ids.includes(r.record_id)) }; break;
      }
      case 'conversation_read': {
        const msgs = (await repo.conversation(id)).messages.filter((m: any) => !a.query || m.text.includes(a.query));
        const offset = z.number().int().nonnegative().parse(a.offset ?? 0), limit = z.number().int().positive().parse(a.limit ?? Math.max(1, msgs.length));
        result = { messages: msgs.slice(offset, offset + limit), total: msgs.length }; break;
      }
      case 'firecrawl_search': case 'firecrawl_scrape': result = await firecrawl(name, a); break;
      default: throw new Error('알 수 없는 조사 도구');
    }
    await repo.event(ctx.runId, 'tool.complete', { name, result });
    return result;
  } catch (e) { await repo.event(ctx.runId, 'tool.error', { name, error: String(e) }); return { error: String(e) }; }
}
