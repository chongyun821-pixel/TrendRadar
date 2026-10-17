import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const storage = mkdtempSync(join(tmpdir(), 'radar-test-'));
process.env.RADAR_STORAGE_DIR = storage;
process.env.RADAR_DB_PATH = join(storage, 'radar.sqlite');
process.env.RADAR_DATABASE = 'sqlite';
const { repository } = await import('../server/store');
await repository().data();
