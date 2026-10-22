import type { Seed, SystemKey, ProgramRecord } from './types';
import { SYSTEM_KEYS } from './types';

export let seed: Seed = { meta: { baseYear: new Date().getFullYear(), collected: '', fx: {}, note: '' }, systems: {} as Seed['systems'], countries: {}, sources: {}, records: [] };
export function setData(data: Seed) { seed = data; }
export function useDataProvider(read: () => Seed) {
  seed = new Proxy({} as Seed, {
    get: (_target, key) => Reflect.get(read(), key),
    ownKeys: () => Reflect.ownKeys(read()),
    has: (_target, key) => key in read(),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Object.getOwnPropertyDescriptor(read(), key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}

const SYS_ALIASES: Record<string, SystemKey> = {
  sph: 'sph', '자주포': 'sph', '포병': 'sph', howitzer: 'sph', artillery: 'sph',
  ifv: 'ifv', '장갑차': 'ifv', '레드백': 'ifv', '보병전투차': 'ifv', '보병전투차량': 'ifv', apc: 'ifv',
  sam: 'sam', '대공미사일': 'sam', '대공': 'sam', '방공': 'sam', '지대공': 'sam', 'air defense': 'sam',
  mrl: 'mrl', mlrs: 'mrl', '다연장로켓': 'mrl', '다연장': 'mrl', '로켓': 'mrl', '천무': 'mrl',
  frigate: 'frigate', '호위함': 'frigate', '프리깃': 'frigate', '함정': 'frigate',
  ssk: 'ssk', '재래식 잠수함': 'ssk', '재래식잠수함': 'ssk', '잠수함': 'ssk', submarine: 'ssk',
};
const GENERAL = ['일반', 'none', 'general', 'off', '끄기'];
/** 삭제한 레이저대공무기 이름은 '대공' 부분 일치로 대공미사일이 되지 않게 어느 체계로도 풀지 않는다 */
const REMOVED = /레이저|laser|천광|dragonfire|iron beam|directed energy/i;

export function resolveSystem(s?: string | null): SystemKey | null {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  if ((SYSTEM_KEYS as readonly string[]).includes(k)) return k as SystemKey;
  if (SYS_ALIASES[k]) return SYS_ALIASES[k];
  if (REMOVED.test(k)) return null;
  for (const [a, v] of Object.entries(SYS_ALIASES)) if (k.includes(a)) return v;
  return null;
}
export const isGeneral = (s?: string | null) => !!s && GENERAL.includes(String(s).trim().toLowerCase());

const C_ALIASES: Record<string, string> = {
  poland: 'POL', romania: 'ROU', norway: 'NOR', finland: 'FIN', estonia: 'EST', uk: 'GBR', 'united kingdom': 'GBR', britain: 'GBR',
  australia: 'AUS', india: 'IND', vietnam: 'VNM', 'viet nam': 'VNM', philippines: 'PHL', indonesia: 'IDN', 'saudi arabia': 'SAU', saudi: 'SAU',
  uae: 'ARE', 'united arab emirates': 'ARE', egypt: 'EGY', canada: 'CAN',
  '오스트레일리아': 'AUS', '사우디': 'SAU', '에미리트': 'ARE', '아랍에미리트': 'ARE', '베트남': 'VNM', '영국': 'GBR',
};
/** 국가명(한/영/ISO3)을 ISO3로. 데이터에 없는 나라는 countryNames(지도용)에서 찾는다. */
export function resolveCountry(s?: string | null, countryNames?: Record<string, string>): string | null {
  if (!s) return null;
  const raw = String(s).trim();
  const k = raw.toLowerCase();
  const up = raw.toUpperCase();
  if (seed.countries[up]) return up;
  if (C_ALIASES[k]) return C_ALIASES[k];
  for (const [iso, c] of Object.entries(seed.countries)) if (c.ko === raw || raw.includes(c.ko)) return iso;
  for (const [a, iso] of Object.entries(C_ALIASES)) if (k.includes(a)) return iso;
  if (countryNames) {
    if (countryNames[up]) return up;
    for (const [iso, n] of Object.entries(countryNames)) if (n === raw || (n.length > 1 && raw.includes(n))) return iso;
  }
  return null;
}

export function findRecord(country: string, system: SystemKey): ProgramRecord | undefined {
  return seed.records.find(r => r.country === country && r.system === system);
}
export function recordsBy(country?: string | null, system?: SystemKey | null): ProgramRecord[] {
  return seed.records.filter(r => (!country || r.country === country) && (!system || r.system === system));
}
