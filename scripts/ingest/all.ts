/**
 * 전체 수집을 의존 순서대로 실행한다. 한 단계가 실패해도 다음 단계를 계속하고 마지막에 실패 목록을 보여준다.
 * 사용: npm run ingest:all -- [--dry-run] [--skip gdelt,oryx]
 * 드라이런에서는 등급·긴장도 단계가 DB를 읽기만 하며, 앞 단계 결과가 DB에 없으므로 참고용이다.
 */
import type { Repository } from '../../server/store';
import { parseArgs, summarize } from '../../server/ingest/common';
import { INGEST_SOURCES } from '../../server/ingest/registry';

const args = parseArgs(process.argv.slice(2));
const skip = new Set(String(args.skip || '').split(',').filter(Boolean));
const failed: string[] = [];
for (const source of INGEST_SOURCES) {
  if (skip.has(source.id)) continue;
  try {
    const result = await source.run({ dryRun: !!args['dry-run'], args: {}, log: line => console.error(`[${source.id}] ${line}`), progress: line => console.error(`[${source.id}] ${line}`) });
    const s = summarize(result);
    console.log(JSON.stringify({ step: source.id, written: s.written, rows: Object.fromEntries(Object.entries(s.tables).map(([t, v]) => [t, v.rows])), notes: s.notes }));
  } catch (e: any) { failed.push(source.id); console.error(`[${source.id}] 실패: ${e?.message || e}`); }
}
for (const repo of (globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> }).__radarRepositories?.values() || []) await repo.close().catch(() => {});
if (failed.length) { console.error(`실패한 단계: ${failed.join(', ')}`); process.exitCode = 1; }
