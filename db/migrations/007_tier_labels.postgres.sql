-- 007 등급 표기 변경 (PostgreSQL / Supabase). 적용: npm run supabase -- schema
UPDATE weights SET note='수출 가능 등급 계수' WHERE factor='tier1' AND note='1세계 등급 계수';
UPDATE weights SET note='조건부 수출 가능 등급 계수' WHERE factor='tier2' AND note='2세계 등급 계수';
INSERT INTO schema_migrations(version,applied_at) VALUES (7, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
