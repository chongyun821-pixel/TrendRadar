import type { SystemKey } from '../shared/types';

export interface SearchCountry { id: string; ko: string; en?: string }
export interface SearchSystem { id: SystemKey; label: string; aliases?: string[] }
export type SearchResult =
  | { kind: 'combined'; country: SearchCountry; system: SearchSystem; label: string }
  | { kind: 'country'; country: SearchCountry; label: string }
  | { kind: 'system'; system: SearchSystem; label: string };

const ALIASES: Partial<Record<SystemKey, string[]>> = {
  sph: ['K9', 'SPH', '자주포', '포병', 'howitzer', 'artillery'],
  ifv: ['IFV', '보병전투차', '보병전투차량', '장갑차', '레드백'],
  sam: ['SAM', '대공미사일', '대공', '방공', '지대공', 'air defense'],
  mrl: ['MRL', 'MLRS', '다연장로켓', '다연장', '천무'],
  frigate: ['호위함', '프리깃', 'frigate'],
  ssk: ['재래식 잠수함', '잠수함', 'SSK', 'submarine'],
};

export function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, '');
}

function rank(query: string, candidates: string[]): number | null {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) return null;
  let best: number | null = null;
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeSearch(candidate);
    if (!normalizedCandidate) continue;
    if (normalizedCandidate === normalizedQuery) best = Math.max(best ?? 0, 100);
    else if (normalizedQuery.includes(normalizedCandidate)) best = Math.max(best ?? 0, 90);
    else if (normalizedCandidate.startsWith(normalizedQuery)) best = Math.max(best ?? 0, 80);
    else if (normalizedCandidate.includes(normalizedQuery)) best = Math.max(best ?? 0, 70);
    else {
      const tokens = query.trim().split(/\s+/).filter(Boolean).map(normalizeSearch);
      if (tokens.some(token => token.length > 1 && (normalizedCandidate.startsWith(token) || normalizedCandidate.includes(token)))) best = Math.max(best ?? 0, 55);
    }
  }
  return best;
}

export function searchMatches(query: string, countries: SearchCountry[], systems: SearchSystem[]): SearchResult[] {
  if (!normalizeSearch(query)) return [];
  const countryHits = countries.map(country => ({ country, score: rank(query, [country.ko, country.en ?? '', country.id]) }))
    .filter((hit): hit is { country: SearchCountry; score: number } => hit.score != null)
    .sort((a, b) => b.score - a.score);
  const systemHits = systems.map(system => ({ system, score: rank(query, [system.label, ...(system.aliases ?? []), ...(ALIASES[system.id] ?? [])]) }))
    .filter((hit): hit is { system: SearchSystem; score: number } => hit.score != null)
    .sort((a, b) => b.score - a.score);
  const combined = countryHits.flatMap(country => systemHits.map(system => ({
    kind: 'combined' as const,
    country: country.country,
    system: system.system,
    label: `${country.country.ko} ${system.system.label}`,
    score: country.score + system.score + 100,
  }))).sort((a, b) => b.score - a.score);
  return [
    ...combined,
    ...countryHits.map(({ country }) => ({ kind: 'country' as const, country, label: country.ko })),
    ...systemHits.map(({ system }) => ({ kind: 'system' as const, system, label: system.label })),
  ];
}
