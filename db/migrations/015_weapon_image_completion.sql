-- Add the remaining located encyclopedia images.
UPDATE weapon_dictionary SET image_url='https://militaryland.net/wp-content/uploads/2025/03/v_ypr765_002.webp', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='aifv';
UPDATE weapon_dictionary SET image_url='https://www.navsource.net/archives/07/images/08/070844.jpg', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='oliver-hazard-perry-class';
INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (15,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision';
