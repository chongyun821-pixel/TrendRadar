/** CLI: npm run ingest:sipri-transfers -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestSipriTransfers } from '../../server/ingest/sipri-transfers';

await runCli('sipri-transfers', ingestSipriTransfers);
