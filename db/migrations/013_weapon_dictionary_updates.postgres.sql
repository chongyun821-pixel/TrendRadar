-- Add researched US and French systems to the encyclopedia without changing procurement records.
INSERT INTO weapon_dictionary
  (id,name,name_ko,aliases,system,type_ko,maker,origin,operators,intro_year,description,specs,variants,est,sources,updated_at)
VALUES
  ('m2a4-bradley','M2A4 Bradley','M2A4 Bradley',ARRAY['M2A4 Bradley','M2A4'],'ifv','보병전투장갑차',NULL,'USA',ARRAY['USA'],2022,
   '미 육군은 2022년에 M2A4 Bradley 첫 부대를 장비했다. 700대 이상은 2029년까지의 현대화 계획 수치이지 현재 재고가 아니다.',
   '{}'::jsonb,ARRAY[]::text[],ARRAY[]::text[],'[{"id":"usa_m2a4_army_2022","t":"US Army equips first unit with modernized Bradley","u":"https://www.army.mil/article/255980/us_army_equips_first_unit_with_modernized_bradley","y":2022}]'::jsonb,now()::text),
  ('vbci','VBCI','VBCI',ARRAY['VBCI','VBCI 8x8','Infantry fighting vehicle VBCI'],'ifv','8×8 보병전투차량',NULL,'FRA',ARRAY['FRA'],NULL,
   '프랑스 8×8 보병전투차량. 프랑스 국방부 2025 통계는 2024년 12월 31일 기준 627대를 기재한다.',
   '{}'::jsonb,ARRAY[]::text[],ARRAY[]::text[],'[{"id":"fra_vbci_dga","t":"Véhicule blindé de combat d’infanterie VBCI","u":"https://www.defense.gouv.fr/dga/vehicule-blinde-combat-dinfanterie-vbci","y":0},{"id":"fra_defense_figures_2025","t":"Chiffres clés de la Défense 2025","u":"https://www.defense.gouv.fr/sites/default/files/ministere-armees/Chiffres_Cle%CC%81s_2025_UK.pdf","y":2025}]'::jsonb,now()::text),
  ('lru-france','LRU','LRU',ARRAY['LRU','Lance-roquettes unitaire','Lance-roquettes unitaires'],'mrl','다연장로켓',NULL,'FRA',ARRAY['FRA'],NULL,
   '프랑스 육군 다연장로켓. 프랑스 국방부 2025 통계는 2024년 12월 31일 기준 9대를 기재한다.',
   '{}'::jsonb,ARRAY[]::text[],ARRAY[]::text[],'[{"id":"fra_lru_army","t":"LRU - Lance-roquette unitaire","u":"https://www.defense.gouv.fr/terre/nos-materiels/nos-equipements-terre/vehicules-larmee-terre/vehicules-dartillerie/lru-lance-roquette-unitaire","y":0},{"id":"fra_defense_figures_2025","t":"Chiffres clés de la Défense 2025","u":"https://www.defense.gouv.fr/sites/default/files/ministere-armees/Chiffres_Cle%CC%81s_2025_UK.pdf","y":2025}]'::jsonb,now()::text),
  ('fdi-class','FDI','FDI',ARRAY['FDI','FDI-class','Defense and Intervention Frigate','Amiral Ronarc’h'],'frigate','다목적 호위함','Naval Group','FRA',ARRAY['FRA'],2025,
   '프랑스 해군 FDI 호위함. 첫 함정 Amiral Ronarc’h는 2025년 10월 인도되어 장기 전개 중이다. DGA는 2026년 3월 다섯 번째 함정을 발주했다. 전체 잔여 인도 기간은 2027~2032년으로 발표됐지만 다섯 번째 함정의 개별 인도 연도는 공개되지 않았다.',
   '{}'::jsonb,ARRAY['Amiral Ronarc’h'],ARRAY[]::text[],'[{"id":"fra_fdi_dga_2026","t":"DGA orders fifth FDI frigate","u":"https://www.defense.gouv.fr/dga/actualites/dga-commande-cinquieme-fregate-defense-dintervention-fdi-naval-group","y":2026}]'::jsonb,now()::text),
  ('constellation-class-ffg','Constellation class','Constellation급',ARRAY['Constellation class','Constellation-class FFG','FFG 62','FFG-62','FFG 63','FFG-63','Congress'],'frigate','유도미사일 호위함','Fincantieri Marinette Marine','USA',ARRAY['USA'],NULL,
   '미 해군 신형 호위함. 2025년 12월 현황표는 FFG-62 건조 중, FFG-63 계약 중으로 표기하지만 같은 페이지 본문은 FFG-63~66 취소를 언급해 FFG-63 상태에 원문 내 불일치가 있다.',
   '{}'::jsonb,ARRAY['Constellation (FFG 62)','Congress (FFG 63)'],ARRAY[]::text[],'[{"id":"usa_constellation_navy_2025","t":"Constellation Class - FFG","u":"https://www.navy.mil/Resources/Fact-Files/Display-FactFiles/Article/2633250/constellation-class-ffg/","y":2025}]'::jsonb,now()::text)
ON CONFLICT (id) DO NOTHING;

UPDATE weapon_dictionary
SET aliases=array_append(aliases,'SAMP/T Mamba'),
    intro_year=COALESCE(intro_year,2010),
    description=description || ' 프랑스 국방부는 Mamba가 2010년부터 운용 중이라고 명시한다.',
    sources=sources || '[{"id":"fra_sampt_mamba_2026","t":"SAMP/T Mamba operational deployment","u":"https://www.defense.gouv.fr/operations/actualites/ffeau-systeme-sampt-mamba-projete-au-moyen-orient-au-profit-partenaires","y":2026}]'::jsonb,
    updated_at=now()::text
WHERE id='samp-t';

UPDATE weapon_dictionary
SET aliases=array_append(aliases,'MIM-104 Patriot'),
    description=description || ' 미 육군은 2025년 Patriot 추가 대대 계획을 발표했다.',
    sources=sources || '[{"id":"usa_patriot_army_2025","t":"Army to bolster Patriot fleet with additional battalions","u":"https://www.army.mil/article/287303/army_to_bolster_patriot_fleet_with_additional_battalions","y":2025}]'::jsonb,
    updated_at=now()::text
WHERE id='patriot';

UPDATE weapon_dictionary
SET description=description || ' 미 육군 2026년 자료는 HIMARS와 M270A2가 운용 중이라고 확인한다.',
    sources=sources || '[{"id":"usa_m270_army_2026","t":"US Army ER GMLRS qualification and platform status","u":"https://www.army.mil/article/290425/u_s_army_completes_m270a2_launch_of_extended_range_gmlrs_completes_aw_qualification","y":2026}]'::jsonb,
    updated_at=now()::text
WHERE id='m270-mlrs';

UPDATE weapon_dictionary
SET description=description || ' 프랑스 국방부 2025 통계는 2024년 12월 31일 기준 CAESAR 74문을 기재한다.',
    sources=sources || '[{"id":"fra_caesar_defense_figures_2025","t":"Chiffres clés de la Défense 2025","u":"https://www.defense.gouv.fr/sites/default/files/ministere-armees/Chiffres_Cle%CC%81s_2025_UK.pdf","y":2025}]'::jsonb,
    updated_at=now()::text
WHERE id='caesar';

UPDATE weapon_dictionary
SET description=description || ' 프랑스 국방부는 2026년 Mistral의 방공 임무와 운용 지역을 소개하고, 2025 통계는 2024년 말 발사대 228기를 집계한다.',
    sources=sources || '[{"id":"fra_mistral_ministry_2026","t":"Système d’arme Mistral (SA MISTRAL)","u":"https://www.defense.gouv.fr/en/eurosatory/stand-and-equipment/eurosatory-2026-equipements-exposes/combat-profondeur/systeme-darme-mistral-sa","y":2026},{"id":"fra_mistral_defense_figures_2025","t":"Chiffres clés de la Défense 2025","u":"https://www.defense.gouv.fr/sites/default/files/ministere-armees/Chiffres_Cle%CC%81s_2025_UK.pdf","y":2025}]'::jsonb,
    updated_at=now()::text
WHERE id='mistral';

UPDATE weapon_dictionary
SET description=description || ' DGA 자료는 8척 구성을 밝히며, 프랑스 국방부 2024 자료는 FREMM 8척이 배치 중이라고 기술한다.',
    sources=sources || '[{"id":"fra_fremm_dga_2024","t":"Euronaval 2024 - French naval programmes","u":"https://www.defense.gouv.fr/actualites/euronaval-2024-programmes-majeurs-qui-vont-faconner-force-daction-navale-demain","y":2024}]'::jsonb,
    updated_at=now()::text
WHERE id='fremm';

INSERT INTO schema_migrations(version,applied_at) VALUES (13,now()::text) ON CONFLICT (version) DO NOTHING;
UPDATE metadata SET value=(CAST(value AS INTEGER)+1)::text WHERE key='revision';
