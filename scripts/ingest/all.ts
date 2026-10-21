/**
 * 전체 수집을 의존 순서대로 실행한다. 한 단계가 실패해도 다음 단계를 계속하고 마지막에 실패 목록을 보여준다.
 * 사용: npm run ingest:all -- [--dry-run] [--skip gdelt,oryx]
 * 드라이런에서는 등급·긴장도 단계가 DB를 읽기만 하며, 앞 단계 결과가 DB에 없으므로 참고용이다.
 */
import type { Repository } from '../../server/store';
import { parseArgs, summarize, type IngestOptions, type IngestResult } from './common';
import { ingestSipriTransfers } from './sipri-transfers';
import { ingestSipriMilex } from './sipri-milex';
import { ingestSipriEmbargoes } from './sipri-embargoes';
import { ingestItar } from './itar';
import { ingestWorldBank } from './worldbank';
import { ingestUcdp } from './ucdp';
import { ingestGdelt } from './gdelt';
import { ingestOryx } from './oryx';
import { ingestTiers } from './tiers';
import { ingestTension } from './tension';

export const STEPS: [string, (o: IngestOptions) => Promise<IngestResult>][] = [
  ['sipri-embargoes', ingestSipriEmbargoes], ['itar', ingestItar], ['sipri-transfers', ingestSipriTransfers], ['sipri-milex', ingestSipriMilex],
  ['worldbank', ingestWorldBank], ['ucdp', ingestUcdp], ['gdelt', ingestGdelt], ['oryx', ingestOryx], ['tiers', ingestTiers], ['tension', ingestTension],
];

const args = parseArgs(process.argv.slice(2));
const skip = new Set(String(args.skip || '').split(',').filter(Boolean));
const failed: string[] = [];
for (const [name, job] of STEPS) {
  if (skip.has(name)) continue;
  try {
    const result = await job({ dryRun: !!args['dry-run'], args: {}, log: line => console.error(`[${name}] ${line}`) });
    const s = summarize(result);
    console.log(JSON.stringify({ step: name, written: s.written, rows: Object.fromEntries(Object.entries(s.tables).map(([t, v]) => [t, v.rows])), notes: s.notes }));
  } catch (e: any) { failed.push(name); console.error(`[${name}] 실패: ${e?.message || e}`); }
}
for (const repo of (globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> }).__radarRepositories?.values() || []) await repo.close().catch(() => {});
if (failed.length) { console.error(`실패한 단계: ${failed.join(', ')}`); process.exitCode = 1; }
