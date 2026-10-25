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
// Natural Earth 1:110m에 경계가 없는 소국. 지도와 지구본에는 경계 대신 점으로 표시한다(위치: 국가 중심 좌표).
const shapeless = [
  { id: 'SGP', a2: 'SG', ko: '싱가포르', en: 'Singapore', lat: 1.352083, lon: 103.819836, aliases: ['Republic of Singapore'] },
  { id: 'BHR', a2: 'BH', ko: '바레인', en: 'Bahrain', lat: 26.0275, lon: 50.55, aliases: ['Kingdom of Bahrain'] },
];
for (const e of shapeless) if (!catalog.some(c => c.id === e.id)) catalog.push({
  id: e.id, ko: e.ko, en: e.en, flag: [...e.a2].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join(''),
  lat: e.lat, lon: e.lon, aliases: [...new Set([e.id, e.a2, e.en, ...e.aliases, e.ko])],
});
writeFileSync('shared/country-catalog.json', JSON.stringify(catalog));
console.log(`countries: ${out.length}`);
