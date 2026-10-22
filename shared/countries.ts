import catalog from './country-catalog.json';
import type { CountryMeta } from './types';

/** scripts/slim-countries.mjs가 저장소의 Natural Earth 원본에서 생성한다. */
export interface CatalogCountry extends CountryMeta { id: string; en: string; aliases: string[] }
export const countryCatalog: readonly CatalogCountry[] = catalog;
export const countryKey = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
const byName = new Map<string, CatalogCountry[]>();
for (const country of countryCatalog) for (const name of new Set(country.aliases.map(countryKey))) {
  const matches = byName.get(name) || [];
  matches.push(country); byName.set(name, matches);
}
/** 등록은 정확하게 일치하는 이름만 허용한다. 부분 일치는 후보 조회에만 쓴다. */
export function catalogCountry(value: string): CatalogCountry | null {
  const matches = byName.get(countryKey(value));
  return matches?.length === 1 ? matches[0] : null;
}
export function searchCountries(value: string): readonly CatalogCountry[] {
  const exact = byName.get(countryKey(value));
  return exact || countryCatalog.filter(c => c.aliases.some(n => countryKey(n).includes(countryKey(value))));
}
export function catalogMetadata(country: CatalogCountry): CountryMeta {
  const { ko, flag, lat, lon } = country;
  return { ko, flag, lat, lon };
}
