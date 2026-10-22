/** 채팅 도구: 공개 자료 수집(SIPRI·World Bank·UCDP·GDELT·Oryx)과 등급·긴장도 산출 실행 */
import { z } from 'zod';
import { execution } from './execution';
import { resolveCountry } from '../shared/data';
import type { ToolDef } from './agent';
import { INGEST_SOURCES, ingestSource } from './ingest/registry';
import { cancelIngest, getIngestRun, ingestOverview, reapStale, startIngest, viewRow, waitIngest, type IngestRunView } from './ingest/jobs';

const S = (description: string) => ({ type: 'string' as const, description });
const I = (description: string) => ({ type: 'integer' as const, description });
const B = (description: string) => ({ type: 'boolean' as const, description });
export const DEFAULT_WAIT = 40, MAX_WAIT = 50;
const IDS = INGEST_SOURCES.map(s => s.id) as [string, ...string[]];

export const INGEST_DEFS: ToolDef[] = [
  { name: 'list_ingest_sources', description: '공개 자료 수집 출처(SIPRI·World Bank·UCDP·GDELT·Oryx)와 등급·긴장도 산출 작업의 채우는 표, 마지막 실행, 저장 행 수를 본다', properties: {} },
  { name: 'run_ingest', description: '공개 자료 수집 또는 등급(tiers)·긴장도(tension) 산출을 실행한다. 기본은 미리보기(dryRun=true)로 행 수와 표본만 보여주고, dryRun=false면 DB에 반영하고 변경 기록을 남긴다. 오래 걸리면 id를 돌려주므로 get_ingest_run으로 확인한다',
    properties: {
      source: S(`수집 출처: ${IDS.join(', ')}`), dryRun: B('true(기본)면 적재하지 않고 미리보기만. 사용자가 반영·적재를 요청했을 때만 false'),
      countries: S('국가 한정(쉼표 구분 국가 ID나 이름, 예: POL,ROU). 생략 시 전체'), since: I('시작 연도(sipri-transfers·sipri-milex·worldbank·ucdp)'),
      year: I('수집 범위의 끝 연도(기본 올해). 판단 기준 연도는 meta.baseYear로 고정'), months: I('GDELT 최근 개월 수(1~24, 기본 12)'), side: S('Oryx 진영: RUS 또는 UKR(생략 시 둘 다)'),
      asOf: S('긴장도 기준 월 YYYY-MM'), wait: I(`응답 대기 초(0~${MAX_WAIT}, 기본 ${DEFAULT_WAIT}). 넘으면 실행 중 상태를 돌려준다`),
    }, required: ['source'] },
  { name: 'get_ingest_run', description: '수집 작업의 진행 상태와 결과 요약을 확인하거나 중지한다', properties: { id: S('run_ingest가 돌려준 작업 id'), wait: I(`끝날 때까지 기다릴 초(0~${MAX_WAIT}, 기본 0)`), cancel: B('true면 작업을 중지') }, required: ['id'] },
];

const bool = z.preprocess(v => v === 'true' ? true : v === 'false' ? false : v, z.boolean());
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const countryList = z.string().max(400).transform((s, ctx) => {
  const ids = s.split(/[,\s]+/).filter(Boolean).map(x => {
    const id = resolveCountry(x) || (/^[A-Za-z]{3}$/.test(x) ? x.toUpperCase() : null);
    if (!id) ctx.addIssue({ code: 'custom', message: `국가를 알 수 없음: ${x}` });
    return id || '';
  });
  return [...new Set(ids.filter(Boolean))];
});
const runSchema = z.object({
  source: z.enum(IDS), dryRun: bool.default(true), countries: countryList.optional(), since: int(1950, 2100).optional(), year: int(1950, 2100).optional(),
  months: int(1, 24).optional(), side: z.preprocess(v => typeof v === 'string' ? v.toUpperCase() : v, z.enum(['RUS', 'UKR'])).optional(),
  asOf: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'YYYY-MM 형식').optional(), wait: int(0, MAX_WAIT).default(DEFAULT_WAIT),
}).strict();
const getSchema = z.object({ id: z.string().uuid(), wait: int(0, MAX_WAIT).default(0), cancel: bool.default(false) }).strict();
const clean = (a: Record<string, any>) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const issue = (e: z.ZodError) => e.issues.map(i => `${i.path.join('.') || '인자'}: ${i.message}`).join('; ');

const FALLBACK_STEPS = {
  apply: '기본 웹 도구(없으면 firecrawl_scrape·collect_source)로 url을 읽어 출처를 보존하고 normalize_procurement_data→validate_research→apply_research로 반영(사용자 요청 시만)',
  source: '기본 웹 도구(없으면 firecrawl_scrape·collect_source)로 url을 읽어 save_source로 보존하고 값·URL·신뢰도를 답변(이 표 적재 도구 없음)',
  derived: '웹 수집 대상 아님. after의 선행 수집을 성공시킨 뒤 다시 실행',
} as const;
/** 실패 시 대체 수집 안내(작게): 원문 쪽 주소, 뽑을 내용, 다음 행동 */
export function fallbackHint(sourceId: string) {
  const src = ingestSource(sourceId);
  if (!src) return undefined;
  const { url, what, save } = src.fallback;
  return { ...(url ? { url } : {}), what, suggestion: FALLBACK_STEPS[save], ...(save === 'derived' && src.after ? { after: src.after } : {}) };
}
/** 모델에 돌려줄 상태: 실행 중이면 다음 행동, 실패면 대체 수집 안내를 함께 준다 */
export function present(view: IngestRunView | null) {
  if (!view) return { error: '수집 작업을 찾을 수 없음' };
  const { summary, ...rest } = view;
  if (view.status === 'failed') return { ...rest, error: view.error ? view.error.slice(0, 300) : null, fallback: fallbackHint(view.source) };
  if (view.status === 'running' || view.status === 'cancelling') return { ...rest, next: `get_ingest_run(id="${view.id}", wait=${DEFAULT_WAIT})로 진행 상황을 확인` };
  return { ...rest, ...(summary ? { summary } : {}), ...(view.status === 'completed' && view.dryRun ? { next: '미리보기 결과. 사용자가 반영을 원하면 같은 인자로 dryRun=false 실행' } : {}) };
}

export async function ingestTool(name: string, args: Record<string, any>) {
  const ctx = await execution();
  const repo = ctx.repo;
  switch (name) {
    case 'list_ingest_sources': {
      await reapStale(repo);
      const out = [];
      for (const s of INGEST_SOURCES) {
        const last = await repo.one('SELECT * FROM ingest_runs WHERE source=? ORDER BY started_at DESC LIMIT 1', s.id);
        const lastWrite = await repo.one("SELECT id, started_at, ended_at, summary FROM ingest_runs WHERE source=? AND dry_run=0 AND status='completed' ORDER BY started_at DESC LIMIT 1", s.id);
        const lw = lastWrite ? viewRow({ ...lastWrite, source: s.id, status: 'completed', dry_run: 0 }) : null;
        out.push({
          source: s.id, name: s.ko, fills: s.fills, params: s.params, seconds: s.seconds, ...(s.after ? { after: s.after } : {}),
          stored: await ingestOverview(repo, s.sourceIds, s.fills),
          lastRun: last ? { id: last.id, status: last.status, dryRun: !!Number(last.dry_run), startedAt: last.started_at, endedAt: last.ended_at, ...(last.error ? { error: String(last.error).slice(0, 200) } : {}), ...(last.status === 'running' ? { progress: last.progress } : {}) } : null,
          lastWrite: lw ? { id: lw.id, endedAt: lw.endedAt, written: lw.summary?.written ?? null } : null,
        });
      }
      return { sources: out, note: '등급(tiers)·긴장도(tension)는 after에 적힌 수집을 먼저 반영한 뒤 실행한다' };
    }
    case 'run_ingest': {
      const parsed = runSchema.safeParse(clean(args));
      if (!parsed.success) throw new Error(`인자 오류: ${issue(parsed.error)}`);
      const { source, dryRun, wait, ...params } = parsed.data;
      const src = ingestSource(source)!;
      const { id } = await startIngest(repo, { source, dryRun, params: clean(params), conversationId: ctx.conversationId, runId: ctx.runId });
      try { return { ...present(await waitIngest(repo, id, wait * 1000, ctx.signal)), expectedSeconds: src.seconds }; }
      catch (e) { if (ctx.signal.aborted) await cancelIngest(repo, id); throw e; }
    }
    case 'get_ingest_run': {
      const parsed = getSchema.safeParse(clean(args));
      if (!parsed.success) throw new Error(`인자 오류: ${issue(parsed.error)}`);
      const { id, wait, cancel } = parsed.data;
      if (!await getIngestRun(repo, id)) throw new Error('수집 작업을 찾을 수 없음');
      if (cancel) await cancelIngest(repo, id);
      else await reapStale(repo);
      return present(await waitIngest(repo, id, (cancel ? Math.max(wait, 5) : wait) * 1000, ctx.signal));
    }
  }
  throw new Error(`알 수 없는 수집 도구: ${name}`);
}
