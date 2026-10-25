-- 012 무기 사전 M92 Vulkan 개발국 정정 (SQLite: 격리 테스트·이전 원본)
-- 근거: MilitaryLeak 2019-01-02. 제조사는 출처에 없어 NULL 유지.
-- 변경 이력(changes)은 공유 PostgreSQL 마이그레이션에서만 남긴다. SQLite는 이전 마이그레이션처럼 이력 행을 만들지 않는다.
UPDATE weapon_dictionary SET origin='HRV', description='M92 Vulkan(LRSV-122 M-92)은 크로아티아가 유고슬라비아제 128mm M-77 Oganj 자주 다연장로켓을 122mm Grad 규격 로켓용으로 개조한 체계다. 발사관을 122mm로 바꾸고 발사함과 사격 체계를 고쳤으며, 크로아티아군이 운용하고 NATO 폴란드 전진배치 전투단에도 배치됐다. 슬로보드나 달마시야는 평균 사용 연한이 30년을 넘고 사거리는 20km까지라고 적는다. 제조사와 취역 연도는 출처에서 확인되지 않는다.', sources=json_insert(sources,'$[#]',json('{"id":"hrv_vulkan_militaryleak","t":"Croatian Army M-92 Vulkan Multiple Launch Rocket System (MilitaryLeak, 2019-01-02)","u":"https://militaryleak.com/2019/01/02/croatian-army-m-92-vulkan-multiple-launch-rocket-system/","y":2019,"publishedAt":"2019-01-02"}')), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE id='m92-vulkan' AND origin IS NOT 'HRV';
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (12, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
