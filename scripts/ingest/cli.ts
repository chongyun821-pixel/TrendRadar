/** 수집 CLI 공통 진입점. 실제 수집은 server/ingest의 라이브러리 함수가 하고, 여기서는 인자 해석과 출력만 한다. */
import type { Repository } from '../../server/store';
import { parseArgs, summarize, type IngestOptions, type IngestResult } from '../../server/ingest/common';

/** --dry-run, --file <경로>, --year <연도>, --countries POL,ROU. 결과 요약을 JSON으로 출력한다 */
export async function runCli(name: string, job: (opts: IngestOptions) => Promise<IngestResult>) {
  const args = parseArgs(process.argv.slice(2));
  const opts: IngestOptions = {
    dryRun: !!args['dry-run'], file: typeof args.file === 'string' ? args.file : undefined, year: args.year ? Number(args.year) : undefined, args,
    countries: typeof args.countries === 'string' ? args.countries.split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : undefined,
    log: line => console.error(`[${name}] ${line}`), progress: line => console.error(`[${name}] ${line}`),
  };
  try {
    const result = await job(opts);
    console.log(JSON.stringify(summarize(result), null, 2));
  } catch (e: any) { console.error(`[${name}] 실패: ${e?.message || e}`); process.exitCode = 1; }
  finally {
    // 작업이 연 저장소만 닫는다(드라이런 중 읽기만 한 경우 포함)
    const open = (globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> }).__radarRepositories;
    for (const repo of open?.values() || []) await repo.close().catch(() => {});
  }
}
