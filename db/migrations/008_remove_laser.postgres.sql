-- 008 레이저대공무기(laser) 모드 삭제 (PostgreSQL / Supabase). 적용: npm run supabase -- schema
-- 004가 넣은 체계·기록·대응 체계·독자 개발 현황과, 이후 수집·계산으로 생긴 laser 행을 지운다.
-- 조사 이력(research)·변경 이력(changes)은 감사 기록이라 남긴다. 앱은 남은 laser 행을 읽지 않는다.
UPDATE metadata SET value=(CAST(value AS BIGINT)+1)::text WHERE key='revision' AND (EXISTS (SELECT 1 FROM systems WHERE id='laser') OR EXISTS (SELECT 1 FROM records WHERE system='laser'));
DELETE FROM forecasts WHERE record_id IN (SELECT id FROM records WHERE system='laser');
DELETE FROM system_links WHERE system='laser';
DELETE FROM domestic_capability WHERE system='laser';
DELETE FROM export_tiers WHERE system='laser';
DELETE FROM inventory WHERE system='laser';
DELETE FROM signals WHERE system='laser';
DELETE FROM consumption WHERE system='laser';
DELETE FROM records WHERE system='laser';
DELETE FROM systems WHERE id='laser';
-- 004가 레이저 기록용으로 넣은 출처 2건. 다른 기록·수집 행이 쓰고 있으면 남긴다.
DELETE FROM sources s WHERE s.id IN ('gbr_dragonfire','kor_cheongwang')
  AND NOT EXISTS (SELECT 1 FROM records r WHERE r.data LIKE '%"' || s.id || '"%')
  AND NOT EXISTS (SELECT 1 FROM system_links l WHERE l.source_id=s.id)
  AND NOT EXISTS (SELECT 1 FROM domestic_capability d WHERE d.source_id=s.id);
INSERT INTO schema_migrations(version,applied_at) VALUES (8, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
