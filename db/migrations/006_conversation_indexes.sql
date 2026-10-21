-- 006 대화 전환·삭제·진행 조회 색인 (SQLite)
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS artifacts_conversation ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS reports_conversation ON reports(conversation_id);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at);
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (6, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
