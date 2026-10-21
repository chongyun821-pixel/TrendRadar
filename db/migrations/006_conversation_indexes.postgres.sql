-- 006 대화 전환·삭제·진행 조회 색인 (PostgreSQL / Supabase)
-- 적용: npm run supabase -- schema. 여러 번 실행해도 안전하다.
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs(conversation_id);
CREATE INDEX IF NOT EXISTS artifacts_conversation ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS reports_conversation ON reports(conversation_id);
CREATE INDEX IF NOT EXISTS conversations_updated ON conversations(updated_at);
INSERT INTO schema_migrations(version,applied_at) VALUES (6, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
