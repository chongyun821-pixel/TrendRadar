/**
 * 수집 작업 실행기: 채팅 도구가 수집을 백그라운드로 돌리고 상태를 ingest_runs에 기록한다.
 * - 출처별 동시 실행은 ingest_runs의 부분 고유 색인(one_running_ingest)으로 막는다(프로세스가 달라도 적용).
 * - 진행 상황은 heartbeat_at, progress 열과 대화 실행의 ingest.progress 이벤트로 남긴다.
 * - 작업은 시작한 프로세스 안에서만 돈다. 프로세스가 끝나 생존 신호가 끊긴 작업은 다음 조회 때 failed로 정리한다.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { now, type Repository } from '../store';
import { summarize, type Fetch, type IngestResult } from './common';
import { ingestSource, type IngestParam } from './registry';

export const HEARTBEAT_MS = 20_000;
export const STALE_MS = 3 * 60_000;
const OWNER = `${hostname()}:${process.pid}`;
const ACTIVE = "status IN ('running','cancelling')";

export interface IngestParams { since?: number; year?: number; months?: number; side?: 'RUS' | 'UKR'; asOf?: string; countries?: string[] }
export interface StartIngest { source: string; params?: IngestParams; dryRun: boolean; conversationId?: string; runId?: string; fetch?: Fetch; file?: string; now?: string }
export interface IngestRunView {
  id: string; source: string; status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled'; dryRun: boolean; params: IngestParams;
  progress: string | null; startedAt: string; endedAt: string | null; error: string | null; summary: CompactSummary | null;
}
export type CompactSummary = ReturnType<typeof compactSummary>;
interface Job { id: string; source: string; controller: AbortController; done: Promise<IngestRunView> }
const runtime = globalThis as typeof globalThis & { __radarIngestJobs?: Map<string, Job> };
const jobs = runtime.__radarIngestJobs ??= new Map<string, Job>();

/** 모델, 기록용 요약: 표별 행 수, 표본 3행, 메모 일부. 전체 자료는 넣지 않는다 */
export function compactSummary(result: IngestResult) {
  const s = summarize(result, 3);
  const notes = s.notes.slice(0, 8).map(n => n.length > 200 ? `${n.slice(0, 200)}…` : n);
  if (s.notes.length > 8) notes.push(`외 메모 ${s.notes.length - 8}건`);
  return { source: { id: s.source.id, title: s.source.title, url: s.source.url }, dryRun: s.dryRun, written: s.written, tables: s.tables, notes };
}

const parse = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? null; } catch { return null; } };
export const viewRow = (r: any): IngestRunView => ({
  id: r.id, source: r.source, status: r.status, dryRun: !!Number(r.dry_run), params: parse(r.params) || {}, progress: r.progress ?? null,
  startedAt: r.started_at, endedAt: r.ended_at ?? null, error: r.error ?? null, summary: parse(r.summary),
});
export async function getIngestRun(repo: Repository, id: string): Promise<IngestRunView | null> {
  const row = await repo.one('SELECT * FROM ingest_runs WHERE id=?', id);
  return row ? viewRow(row) : null;
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; }
}
/** 이 프로세스가 돌리지 않는 실행 중 작업 가운데, 같은 호스트에서 프로세스가 끝났거나 생존 신호가 끊긴 것을 실패로 정리한다 */
export async function reapStale(repo: Repository) {
  const rows = await repo.all(`SELECT id, owner, heartbeat_at FROM ingest_runs WHERE ${ACTIVE}`);
  for (const r of rows) {
    if (jobs.has(r.id)) continue;
    const [host, pid] = String(r.owner || '').split(':');
    const dead = (host === hostname() && Number(pid) && Number(pid) !== process.pid && !pidAlive(Number(pid))) || (host === hostname() && Number(pid) === process.pid) || Date.now() - Date.parse(r.heartbeat_at) > STALE_MS;
    if (dead) await repo.run(`UPDATE ingest_runs SET status='failed', error=?, ended_at=? WHERE id=? AND ${ACTIVE}`, '작업 프로세스가 종료되어 중단됨(생존 신호 없음)', now(), r.id);
  }
}

const argsFor = (p: IngestParams): Record<string, string | boolean> => ({
  ...(p.since ? { since: String(p.since) } : {}), ...(p.months ? { months: String(p.months) } : {}),
  ...(p.side ? { side: p.side } : {}), ...(p.asOf ? { 'as-of': p.asOf } : {}),
});

/** 작업을 시작하고 즉시 id를 돌려준다. done은 끝난 뒤의 상태 */
export async function startIngest(repo: Repository, o: StartIngest): Promise<{ id: string; done: Promise<IngestRunView> }> {
  const source = ingestSource(o.source);
  if (!source) throw new Error(`알 수 없는 수집 출처: ${o.source}`);
  const params = o.params || {};
  const unsupported = (Object.keys(params) as IngestParam[]).filter(k => params[k] !== undefined && !source.params.includes(k));
  if (unsupported.length) throw new Error(`${source.id}에서 쓰지 않는 인자: ${unsupported.join(', ')} (허용: ${source.params.join(', ') || '없음'})`);
  await reapStale(repo);
  const id = randomUUID(), started = now();
  try {
    await repo.run('INSERT INTO ingest_runs(id,source,params,dry_run,status,progress,conversation_id,run_id,owner,started_at,heartbeat_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id, source.id, JSON.stringify(params), o.dryRun ? 1 : 0, 'running', '시작', o.conversationId ?? null, o.runId ?? null, OWNER, started, started);
  } catch (e: any) {
    if (e?.code !== '23505' && !/UNIQUE constraint failed/i.test(String(e?.message))) throw e;
    const running = await repo.one(`SELECT id, started_at, progress FROM ingest_runs WHERE source=? AND ${ACTIVE}`, source.id);
    throw new Error(`이미 실행 중인 ${source.id} 수집이 있습니다(id ${running?.id}, 시작 ${running?.started_at}, ${running?.progress || ''}). get_ingest_run으로 확인하거나 중지하세요`);
  }
  const controller = new AbortController();
  let lastEvent = 0;
  const event = async (name: string, data: unknown) => { if (o.runId) await repo.event(o.runId, name, data).catch(() => {}); };
  const beat = async (message?: string) => {
    const row = await repo.one('SELECT status FROM ingest_runs WHERE id=?', id);
    if (row?.status === 'cancelling' && !controller.signal.aborted) controller.abort(new Error('사용자 요청으로 중지'));
    await repo.run('UPDATE ingest_runs SET heartbeat_at=?, progress=COALESCE(?,progress) WHERE id=?', now(), message ?? null, id);
    if (message && Date.now() - lastEvent > 1500) { lastEvent = Date.now(); await event('ingest.progress', { id, source: source.id, message: `${source.ko}: ${message}` }); }
    controller.signal.throwIfAborted();
  };
  const timer = setInterval(() => { beat().catch(() => {}); }, HEARTBEAT_MS);
  timer.unref?.();
  const done = (async (): Promise<IngestRunView> => {
    try {
      await event('ingest.progress', { id, source: source.id, message: `${source.ko} ${o.dryRun ? '미리보기' : '수집'} 시작` });
      const result = await source.run({
        dryRun: o.dryRun, repo, fetch: o.fetch, file: o.file, now: o.now, year: params.year, countries: params.countries, args: argsFor(params),
        signal: controller.signal, progress: message => beat(message),
      });
      const summary = compactSummary(result);
      const ended = now();
      if (!o.dryRun) {
        // 변경 기록: 무엇을 어느 출처로 몇 행 적재했는지(근거 = 출처 식별자, 주소, 작업 id)
        await repo.run('INSERT INTO changes(record_id,run_id,before_data,after_data,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?)',
          `@ingest:${source.id}`, o.runId || id, null, JSON.stringify({ ingestRun: id, written: summary.written, rows: Object.fromEntries(Object.entries(summary.tables).map(([t, v]) => [t, v.rows])) }),
          `공개 자료 수집: ${source.ko}`, JSON.stringify([{ sourceId: summary.source.id, url: summary.source.url, title: summary.source.title, ingestRun: id }]), ended);
      }
      await repo.run('UPDATE ingest_runs SET status=?, summary=?, progress=?, heartbeat_at=?, ended_at=? WHERE id=?', 'completed', JSON.stringify(summary), '완료', ended, ended, id);
      await event('ingest.progress', { id, source: source.id, message: `${source.ko} ${o.dryRun ? '미리보기' : '수집'} 완료` });
    } catch (e: any) {
      const cancelled = controller.signal.aborted;
      const message = cancelled ? String(controller.signal.reason?.message || '중지됨') : String(e?.message || e);
      await repo.run('UPDATE ingest_runs SET status=?, error=?, ended_at=? WHERE id=?', cancelled ? 'cancelled' : 'failed', message.slice(0, 1000), now(), id).catch(() => {});
      await event('ingest.progress', { id, source: source.id, message: `${source.ko} ${cancelled ? '중지' : `실패: ${message.slice(0, 120)}`}` });
    } finally { clearInterval(timer); jobs.delete(id); }
    return (await getIngestRun(repo, id))!;
  })();
  jobs.set(id, { id, source: source.id, controller, done });
  return { id, done };
}

/** 끝나거나 ms가 지날 때까지 기다린다. 다른 프로세스의 작업은 DB를 2초 간격으로 확인한다 */
export async function waitIngest(repo: Repository, id: string, ms: number, signal?: AbortSignal): Promise<IngestRunView | null> {
  const local = jobs.get(id);
  const deadline = Date.now() + ms;
  const abort = new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  if (signal?.aborted) throw signal.reason;
  if (local) {
    let t: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>(r => { t = setTimeout(() => r(null), Math.max(0, ms)); });
    try { await Promise.race([local.done, timeout, abort]); } finally { clearTimeout(t); }
    return getIngestRun(repo, id);
  }
  for (;;) {
    const view = await getIngestRun(repo, id);
    if (!view || !['running', 'cancelling'].includes(view.status) || Date.now() >= deadline) return view;
    await Promise.race([new Promise(r => setTimeout(r, Math.min(2000, deadline - Date.now()))), abort]);
  }
}

/** 중지 요청. 이 프로세스의 작업이면 바로 중단하고, 다른 프로세스의 작업은 다음 생존 신호 때 멈춘다 */
export async function cancelIngest(repo: Repository, id: string) {
  await repo.run(`UPDATE ingest_runs SET status='cancelling' WHERE id=? AND status='running'`, id);
  const local = jobs.get(id);
  if (local && !local.controller.signal.aborted) local.controller.abort(new Error('사용자 요청으로 중지'));
  await reapStale(repo);
}

/** 출처별 마지막 실행, 마지막 적재와 현재 저장 행 수 */
export async function ingestOverview(repo: Repository, sourceIds: string[], tables: string[]) {
  const counts: Record<string, { rows: number; latest: string | null }> = {};
  const marks = sourceIds.map(() => '?').join(',');
  for (const t of tables) {
    const r = await repo.one(`SELECT COUNT(*) AS n, MAX(collected_at) AS latest FROM ${t} WHERE source_id IN (${marks})`, ...sourceIds);
    counts[t] = { rows: Number(r?.n || 0), latest: r?.latest ?? null };
  }
  return counts;
}
export const isLocalJob = (id: string) => jobs.has(id);
