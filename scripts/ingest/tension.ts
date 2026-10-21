/** CLI: npm run ingest:tension -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestTension } from '../../server/ingest/tension';

await runCli('tension', ingestTension);
