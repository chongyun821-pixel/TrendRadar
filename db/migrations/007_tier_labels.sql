-- 007 등급 표기 변경(1·2·3세계 → 수출 가능·조건부 수출 가능·수출 불가). 저장 값(tier 1·2·3)은 그대로다.
UPDATE weights SET note='수출 가능 등급 계수' WHERE factor='tier1' AND note='1세계 등급 계수';
UPDATE weights SET note='조건부 수출 가능 등급 계수' WHERE factor='tier2' AND note='2세계 등급 계수';
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (7, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
