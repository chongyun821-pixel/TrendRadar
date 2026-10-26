-- Remove remaining manufacturer and navy attribution language from descriptions.
UPDATE weapon_dictionary SET description='SIGMA 155는 이스라엘 Elbit Systems의 155mm 52구경장 차륜형 자주곡사포로, 이스라엘군 명칭은 Ro’em이다. 10x10 차체와 자동 장전 장치를 갖춰 운용 인원을 줄인다. 노후 M109 자주포를 대체하는 장비다.', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='sigma-155';
UPDATE weapon_dictionary SET description='45형 Daring급은 영국 해군의 방공·대미사일 구축함 6척이다. 배수량 7,350t, 전장 152m, 최고속도 30노트, 항속거리 7,000해리다. Sea Viper는 10초 안에 8발을 발사하고 동시에 최대 16발을 유도한다. 격납고와 비행갑판은 Merlin 헬기 1대를 지원한다.', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='type-45';
UPDATE weapon_dictionary SET description='울라급은 노르웨이 해군의 재래식 디젤-전기 잠수함으로, 독일 Thyssen Nordseewerke가 설계·건조한 210형이다.', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='ula-class';
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (18,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision';
