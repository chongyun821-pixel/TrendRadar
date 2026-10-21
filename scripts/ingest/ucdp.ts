/** CLI: npm run ingest:ucdp -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestUcdp } from '../../server/ingest/ucdp';

await runCli('ucdp', ingestUcdp);
