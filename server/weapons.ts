import { countryName } from '../shared/country-name';
import { seed } from '../shared/data';
import type { SystemKey } from '../shared/types';
import { repository, type Repository } from './store';
import { koreanizeHanwha } from '../shared/hanwha';

export interface WeaponEntry {
  id: string; name: string; nameKo: string; aliases: string[]; system: SystemKey; systemKo: string;
  typeKo: string; maker: string | null; origin: string | null; originKo: string; operators: string[];
  operatorsKo: string[]; introYear: number | null; description: string; specs: Record<string, unknown>;
  imageUrl: string | null; variants: string[]; sources: { id: string; t: string; u: string; y: number }[]; est: string[];
}
const parsed = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return (value ?? fallback) as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
export function normalizeWeaponRow(row: any): WeaponEntry {
  const aliases = parsed<string[]>(row.aliases, []), operators = parsed<string[]>(row.operators, []);
  const origin = row.origin || null;
  return { id: row.id, name: row.name, nameKo: row.name_ko, aliases, system: row.system,
    systemKo: seed.systems[row.system as SystemKey]?.ko ?? row.system, typeKo: row.type_ko ?? '', maker: row.maker ? koreanizeHanwha(row.maker) : null,
    origin, originKo: origin ? countryName(origin) : '', operators, operatorsKo: operators.map(country => countryName(country)),
    introYear: row.intro_year == null ? null : Number(row.intro_year), description: row.description,
    specs: parsed(row.specs, {}), imageUrl: row.image_url || null,
    variants: parsed(row.variants, []), sources: parsed(row.sources, []), est: parsed(row.est, []) };
}
let cacheRepo: Repository | undefined, cacheRevision = -1, cacheRows: WeaponEntry[] = [];
export async function allWeapons(repo = repository()): Promise<WeaponEntry[]> {
  const revision = await repo.revision();
  if (cacheRepo !== repo || cacheRevision !== revision) {
    cacheRows = (await repo.all('SELECT * FROM weapon_dictionary ORDER BY id')).map(normalizeWeaponRow);
    cacheRepo = repo; cacheRevision = revision;
  }
  return cacheRows;
}
const norm = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
export async function lookupWeapon(query: string, system?: string, repo = repository()) {
  const q = norm(query || ''); if (!q) return { match: null, candidates: [] as WeaponEntry[] };
  const rows = await allWeapons(repo);
  const terms = (w: WeaponEntry) => [w.id, w.name, w.nameKo, ...w.aliases].map(norm).filter(Boolean);
  const filtered = rows.filter(w => !system || w.system === system);
  const exact = filtered.filter(w => terms(w).includes(q));
  const matches = exact.length ? exact : filtered.filter(w => terms(w).some(t => t.includes(q) || q.includes(t)));
  matches.sort((a, b) => Math.max(...terms(b).filter(t => t.includes(q) || q.includes(t)).map(t => t.length), 0) - Math.max(...terms(a).filter(t => t.includes(q) || q.includes(t)).map(t => t.length), 0) || a.id.localeCompare(b.id));
  return { match: matches[0] ?? null, candidates: matches.slice(1, 5) };
}
