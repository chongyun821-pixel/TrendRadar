/** CLI: npm run ingest:tiers -- [--dry-run] [--file 경로] [--countries POL,ROU] … (옵션은 docs/data-collection.md) */
import { runCli } from './cli';
import { ingestTiers } from '../../server/ingest/tiers';

await runCli('tiers', ingestTiers);
