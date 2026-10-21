-- 005 수집 작업 기록 (SQLite). 표 구조는 db/schema.sql에도 있다.
CREATE TABLE IF NOT EXISTS ingest_runs (id TEXT PRIMARY KEY, source TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(params)), dry_run INTEGER NOT NULL CHECK(dry_run IN (0,1)), status TEXT NOT NULL CHECK(status IN ('running','cancelling','completed','failed','cancelled')), progress TEXT, summary TEXT CHECK(summary IS NULL OR json_valid(summary)), error TEXT, conversation_id TEXT, run_id TEXT, owner TEXT, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, ended_at TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_ingest ON ingest_runs(source) WHERE status IN ('running','cancelling');
CREATE INDEX IF NOT EXISTS ingest_runs_source ON ingest_runs(source, started_at);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (5, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
