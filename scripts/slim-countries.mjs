// Natural Earth 1:110m 국가 경계(GeoJSON) → public/countries.json (필요 속성만, 좌표 소수 2자리)
// 원본: https://github.com/nvkelso/natural-earth-vector (public domain)
import { readFileSync, writeFileSync } from 'node:fs';
const src = JSON.parse(readFileSync('data/ne_110m_admin_0_countries.geojson', 'utf8'));
const r = c => (typeof c[0] === 'number' ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(r));
const out = src.features.map(f => {
  const p = f.properties, g = f.geometry;
  return { id: p.ADM0_A3, ko: p.NAME_KO || p.NAME, en: p.NAME, p: r(g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates]) };
});
writeFileSync('public/countries.json', JSON.stringify(out));
console.log(`countries: ${out.length}`);
