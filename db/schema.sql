-- (선택) Cloudflare D1 / SQLite 스키마. 현재 앱은 data/seed.json 을 직접 사용합니다.
-- wrangler d1 create procurement-radar && wrangler d1 execute procurement-radar --file db/schema.sql
CREATE TABLE IF NOT EXISTS sources   (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, year INTEGER, collected TEXT);
CREATE TABLE IF NOT EXISTS countries (iso3 TEXT PRIMARY KEY, name_ko TEXT NOT NULL, lat REAL, lon REAL);
CREATE TABLE IF NOT EXISTS lifespan  (system TEXT PRIMARY KEY, design_life INTEGER NOT NULL, estimate INTEGER NOT NULL DEFAULT 1, source_id TEXT REFERENCES sources(id));
CREATE TABLE IF NOT EXISTS inventory (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, system TEXT NOT NULL, model TEXT NOT NULL,
  qty INTEGER, intro_year INTEGER, covered INTEGER DEFAULT 0, est_fields TEXT, source_ids TEXT);
CREATE TABLE IF NOT EXISTS programs  (id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, system TEXT NOT NULL, model TEXT, contract_year INTEGER,
  qty INTEGER, amount_krw_eok REAL, delivery_end INTEGER, covers REAL, description TEXT, est_fields TEXT, source_ids TEXT);
CREATE TABLE IF NOT EXISTS mro_events(id INTEGER PRIMARY KEY AUTOINCREMENT, country TEXT NOT NULL, system TEXT NOT NULL, model TEXT, year INTEGER,
  description TEXT, life_ext INTEGER DEFAULT 0, est_fields TEXT, source_ids TEXT);
CREATE TABLE IF NOT EXISTS forecasts (country TEXT NOT NULL, system TEXT NOT NULL, start_year INTEGER, end_year INTEGER, qty_min INTEGER, qty_max INTEGER,
  krw_min REAL, krw_max REAL, confidence TEXT, evidence TEXT, computed_at TEXT, PRIMARY KEY (country, system));
