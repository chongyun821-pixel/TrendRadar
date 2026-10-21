/** CLI: npm run ingest:sipri-embargoes -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestSipriEmbargoes } from '../../server/ingest/sipri-embargoes';

await runCli('sipri-embargoes', ingestSipriEmbargoes);
