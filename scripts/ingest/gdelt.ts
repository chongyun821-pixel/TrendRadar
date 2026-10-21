/** CLI: npm run ingest:gdelt -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestGdelt } from '../../server/ingest/gdelt';

await runCli('gdelt', ingestGdelt);
