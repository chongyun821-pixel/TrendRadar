/** CLI: npm run ingest:oryx -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestOryx } from '../../server/ingest/oryx';

await runCli('oryx', ingestOryx);
