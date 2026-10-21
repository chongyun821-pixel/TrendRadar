/** CLI: npm run ingest:sipri-milex -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestSipriMilex } from '../../server/ingest/sipri-milex';

await runCli('sipri-milex', ingestSipriMilex);
