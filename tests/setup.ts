import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const storage = mkdtempSync(join(tmpdir(), 'radar-test-'));
process.env.RADAR_STORAGE_DIR = storage;
process.env.RADAR_DB_PATH = join(storage, 'radar.sqlite');
process.env.RADAR_DATABASE = 'sqlite';
process.env.RADAR_APP_URL = 'http://127.0.0.1:9'; // 화면 도구가 실제 개발 서버(62356)에 명령을 보내지 않게 닫힌 포트를 쓴다
const { repository } = await import('../server/store');
await repository().data();
