/** CLI: npm run ingest:itar -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestItar } from '../../server/ingest/itar';

await runCli('itar', ingestItar);
