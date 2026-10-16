export type SystemKey = 'sph' | 'ifv' | 'sam' | 'mrl' | 'frigate' | 'ssk';
export const SYSTEM_KEYS: SystemKey[] = ['sph', 'ifv', 'sam', 'mrl', 'frigate', 'ssk'];
export type Category = 'red' | 'orange' | 'yellow' | 'blue' | 'gray';

export interface Source { t: string; u: string; y: number; publishedAt?: string | null; collectedAt?: string; filePath?: string; hash?: string; kind?: 'original' | 'search' | 'attachment'; excerpt?: string }
export interface Batch { model: string; introYear: number; qty: number; lifeExt?: number; covered?: boolean; est?: string[]; note?: string; src: string[] }
export interface Awarded { year: number; text: string; qty: number; deliveryEnd: number; covers: number; est?: string[]; src: string[] }
export interface Plan { start: number; end: number; qty: [number, number]; text: string; est?: string[]; src: string[] }
export interface Mro { year: number; text: string; lifeExt: number; est?: string[]; src: string[] }
export interface Signal { year: number; text: string; src: string[] }
export interface ProgramRecord {
  id: string; country: string; system: SystemKey;
  batches: Batch[]; awarded?: Awarded; plan?: Plan; mro?: Mro[]; signals?: Signal[];
  ratio?: [number, number]; ratioEst?: boolean; src: string[];
  projects?: { id: string; buyer: string; supplier: string; stage: 'consideration' | 'plan' | 'tender' | 'contract' | 'delivery' | 'cancelled'; text: string; qty?: number; amount?: number; currency?: string; src: string[] }[];
  analysis?: { facts: string[]; estimates: string[]; conflicts: string[]; unknowns: string[]; opportunity?: string };
}
export interface SystemMeta { ko: string; unit: string; designLife: number; unitCost: [number, number]; unitCostEst: boolean; unitCostBasis: string; costSrc: string[]; hanwha: string[] }
export interface CountryMeta { ko: string; flag: string; lat: number; lon: number }
export interface Seed {
  meta: { baseYear: number; collected: string; fx: Record<string, number | string>; note: string };
  systems: Record<SystemKey, SystemMeta>;
  countries: Record<string, CountryMeta>;
  sources: Record<string, Source>;
  records: ProgramRecord[];
}

export interface BatchCalc { model: string; introYear: number; qty: number; life: number; ext: number; year: number; est: string[] }
export interface Forecast {
  id: string; country: string; countryKo: string; flag: string; system: SystemKey; systemKo: string; unit: string;
  status: 'open' | 'plan' | 'next' | 'none';
  window: [number, number] | null; remaining: number | null; category: Category; score: number;
  qty: [number, number]; krw: [number, number]; size: number; // size = 0..1 (log scale)
  confidence: '상' | '중' | '하'; nSources: number; latestSource: number; estCount: number;
  current: BatchCalc | null; batches: BatchCalc[];
  calc: string[]; sources: Source[];
  qtyEst: boolean; krwEst: boolean; lifeEst: boolean;
}
