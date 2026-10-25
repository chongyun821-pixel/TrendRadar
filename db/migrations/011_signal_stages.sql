-- 011 수입 신호(signals) 단계명 통일 (SQLite: 격리 테스트·이전 원본)
-- 사업(projects) 단계와 같은 이름을 쓴다: review→consideration, selection→selected. SQLite는 CHECK를 바꿀 수 없어 표를 다시 만든다.
-- 변경 이력(changes)은 공유 PostgreSQL 마이그레이션에서만 남긴다. SQLite는 이전 마이그레이션처럼 이력 행을 만들지 않는다.
CREATE TABLE signals_011 (id TEXT PRIMARY KEY, country TEXT NOT NULL, system TEXT NOT NULL, model TEXT, maker TEXT, supplier TEXT, stage TEXT NOT NULL CHECK(stage IN ('consideration','tender','selected','contract','delivery','cancelled')), quantity INTEGER, value_usd_m REAL, expected_year INTEGER, published_at TEXT, url TEXT, note TEXT, source_id TEXT, confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1), collected_at TEXT);
INSERT INTO signals_011(id,country,system,model,maker,supplier,stage,quantity,value_usd_m,expected_year,published_at,url,note,source_id,confidence,collected_at)
  SELECT id,country,system,model,maker,supplier,CASE stage WHEN 'review' THEN 'consideration' WHEN 'selection' THEN 'selected' ELSE stage END,quantity,value_usd_m,expected_year,published_at,url,note,source_id,confidence,collected_at FROM signals;
DROP TABLE signals;
ALTER TABLE signals_011 RENAME TO signals;
CREATE INDEX IF NOT EXISTS signals_country_system ON signals(country, system);
-- SQLite는 Repository를 열 때 캐시 전에 적용되므로 revision을 올리지 않는다(004와 같음).
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (11, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
