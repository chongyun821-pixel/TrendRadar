-- Distinguish BAE Systems plc from the U.S. Bradley production entity.
UPDATE weapon_dictionary SET maker='BAE Systems Land & Armaments L.P.', description='미국 펜실베이니아주 요크에서 BAE Systems Land & Armaments L.P.가 생산하는 미국제 궤도형 보병전투차량이다. BAE Systems plc는 영국 본사 모기업이다. 25mm 기관포, 7.62mm 동축기관총과 TOW 대전차미사일 발사기를 장착하며 승무원 3명과 보병 6명을 수송한다.', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='m2-bradley';
UPDATE weapon_dictionary SET maker='BAE Systems Land & Armaments L.P.', description='M2 Bradley의 개량형으로, BAE Systems 그룹의 미국 법인 BAE Systems Land & Armaments L.P.가 펜실베이니아주 요크에서 생산한다. 영국 회사 BAE Systems plc의 미국 사업 조직이다. 25mm 기관포와 TOW 대전차미사일 발사기를 유지하면서 전자장비·전력계통·방호력을 개선했다.', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='m2a4-bradley';
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (20,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision';
