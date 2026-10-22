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
// 챗봇과 화면이 같은 국가 ID·이름을 사용한다. 지도 위치는 Natural Earth의 label point다.
const names = { TUR: ['튀르키예', '터키', 'Türkiye', 'Turkiye'], CHN: ['중국'], TWN: ['대만', '타이완'], PRK: ['북한'], KOR: ['대한민국', '한국', '남한'], USA: ['미국', 'USA', 'US'], GBR: ['영국', 'UK', 'Britain'], RUS: ['러시아'] };
const catalog = src.features.map(f => {
  const p = f.properties, id = p.ADM0_A3, a2 = p.ISO_A2_EH;
  return {
    id, ko: names[id]?.[0] || p.NAME_KO || p.NAME, en: p.NAME_EN || p.NAME,
    flag: /^[A-Z]{2}$/.test(a2) ? [...a2].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join('') : '',
    lat: p.LABEL_Y, lon: p.LABEL_X,
    aliases: [...new Set([id, p.ISO_A3, a2, p.NAME, p.NAME_LONG, p.ADMIN, p.FORMAL_EN, p.NAME_KO, p.NAME_EN, p.NAME_SORT, ...(names[id] || [])].filter(n => n && n !== '-99'))],
  };
});
writeFileSync('shared/country-catalog.json', JSON.stringify(catalog));
console.log(`countries: ${out.length}`);
