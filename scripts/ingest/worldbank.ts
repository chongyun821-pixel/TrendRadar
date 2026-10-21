/** CLI: npm run ingest:worldbank -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestWorldBank } from '../../server/ingest/worldbank';

await runCli('worldbank', ingestWorldBank);
