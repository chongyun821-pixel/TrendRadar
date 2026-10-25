-- 011 수입 신호(signals) 단계명 통일 (PostgreSQL / Supabase. 적용: npm run supabase -- schema)
-- 사업(projects) 단계와 같은 이름을 쓴다: review→consideration, selection→selected. 바뀐 행은 변경 이력(changes)에 한 줄로 남긴다.
INSERT INTO changes(record_id,run_id,before_data,after_data,reason,evidence,created_at)
  SELECT '@signal-stage-rename','signal-stage-rename:2026-10-25', json_object_agg('signals:'||id, stage)::text,
    json_object_agg('signals:'||id, CASE stage WHEN 'review' THEN 'consideration' ELSE 'selected' END)::text,
    '수입 신호 단계명을 사업 단계명과 맞춤: review→consideration, selection→selected', json_build_array(json_build_object('rule','signal-stage-rename','table','signals','count',count(*)))::text,
    to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  FROM signals WHERE stage IN ('review','selection') HAVING count(*) > 0;
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_stage_check;
UPDATE signals SET stage = CASE stage WHEN 'review' THEN 'consideration' WHEN 'selection' THEN 'selected' ELSE stage END WHERE stage IN ('review','selection');
ALTER TABLE signals ADD CONSTRAINT signals_stage_check CHECK(stage IN ('consideration','tender','selected','contract','delivery','cancelled'));
UPDATE metadata SET value=(CAST(value AS BIGINT)+1)::text WHERE key='revision' AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version=11);
INSERT INTO schema_migrations(version,applied_at) VALUES (11, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT DO NOTHING;
