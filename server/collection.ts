/** 데이터 수집 테이블(마이그레이션 004)의 읽기, 쓰기. SQLite와 Supabase에서 같은 SQL과 같은 값 형식을 쓴다. */
import type { Repository } from './store';
import type { BudgetRow, CapacityRow, ConsumptionRow, DomesticRow, ExportControlRow, ExportTierRow, InventoryRow, NeighborRow, PairEventRow, SignalRow, SystemKey, SystemLinkRow, WeightRow } from '../shared/types';
import { SYSTEM_KEYS } from '../shared/types';
import { DEFAULT_WEIGHTS, type ScoreInputs } from '../shared/forecast';

type Kind = 'text' | 'int' | 'num' | 'json' | 'bool';
interface TableSpec { key: string[]; columns: Record<string, Kind> }
const COMMON: Record<string, Kind> = { source_id: 'text', confidence: 'num', collected_at: 'text' };
export const COLLECTION_TABLES = {
  system_links: { key: ['system', 'model'], columns: { system: 'text', model: 'text', maker: 'text', is_group: 'bool', relation: 'text', ...COMMON } },
  export_tiers: { key: ['country', 'system'], columns: { country: 'text', system: 'text', tier: 'int', tier_reasons: 'json', tier_checked_at: 'text', ...COMMON } },
  export_controls: { key: ['id'], columns: { id: 'text', country: 'text', regime: 'text', name: 'text', status: 'text', started: 'text', ended: 'text', url: 'text', ...COMMON } },
  neighbors: { key: ['country', 'neighbor'], columns: { country: 'text', neighbor: 'text', kind: 'text', tension: 'num', components: 'json', computed_at: 'text', ...COMMON } },
  inventory: { key: ['id'], columns: { id: 'text', country: 'text', system: 'text', model: 'text', quantity: 'int', delivered_year: 'int', service_life: 'int', retire_year: 'int', supplier: 'text', ...COMMON } },
  budgets: { key: ['country', 'year'], columns: { country: 'text', year: 'int', usd_m: 'num', gdp_pct: 'num', yoy_pct: 'num', gdp_usd_m: 'num', ...COMMON } },
  signals: { key: ['id'], columns: { id: 'text', country: 'text', system: 'text', model: 'text', maker: 'text', supplier: 'text', stage: 'text', quantity: 'int', value_usd_m: 'num', expected_year: 'int', published_at: 'text', url: 'text', note: 'text', ...COMMON } },
  consumption: { key: ['id'], columns: { id: 'text', conflict: 'text', user_country: 'text', target_country: 'text', system: 'text', model: 'text', quantity: 'int', period: 'text', kind: 'text', ...COMMON } },
  supplier_capacity: { key: ['maker', 'model', 'year'], columns: { maker: 'text', model: 'text', year: 'int', annual_output: 'int', backlog: 'int', ...COMMON } },
  domestic_capability: { key: ['country', 'system'], columns: { country: 'text', system: 'text', status: 'text', program: 'text', ...COMMON } },
  weights: { key: ['factor'], columns: { factor: 'text', weight: 'num', note: 'text' } },
  pair_events: { key: ['source', 'country', 'counterpart', 'period'], columns: { source: 'text', country: 'text', counterpart: 'text', period: 'text', events: 'num', fatalities: 'num', goldstein: 'num', ...COMMON } },
} as const satisfies Record<string, TableSpec>;
export type CollectionTable = keyof typeof COLLECTION_TABLES;
export interface RowTypes { system_links: SystemLinkRow; export_tiers: ExportTierRow; export_controls: ExportControlRow; neighbors: NeighborRow; inventory: InventoryRow; budgets: BudgetRow; signals: SignalRow; consumption: ConsumptionRow; supplier_capacity: CapacityRow; domestic_capability: DomesticRow; weights: WeightRow; pair_events: PairEventRow }

function encode(kind: Kind, value: unknown): string | number | null {
  if (value === undefined || value === null || value === '') return null;
  if (kind === 'json') return typeof value === 'string' ? JSON.stringify(JSON.parse(value)) : JSON.stringify(value);
  if (kind === 'bool') return value ? 1 : 0;
  if (kind === 'int') { const n = Math.round(Number(value)); if (!Number.isFinite(n)) throw new Error(`정수가 아닌 값: ${value}`); return n; }
  if (kind === 'num') { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`숫자가 아닌 값: ${value}`); return n; }
  return String(value);
}
function decode<T extends CollectionTable>(table: T, row: Record<string, any>): RowTypes[T] {
  const spec: TableSpec = COLLECTION_TABLES[table];
  const out: Record<string, unknown> = {};
  for (const [name, kind] of Object.entries(spec.columns)) {
    const v = row[name];
    out[name] = v === null || v === undefined ? null : kind === 'json' ? (typeof v === 'string' ? JSON.parse(v) : v) : kind === 'bool' ? Boolean(Number(v)) : kind === 'int' || kind === 'num' ? Number(v) : String(v);
  }
  return out as unknown as RowTypes[T];
}

/**
 * 키가 같은 행은 갱신하고 새 행은 넣는다. fill에 적은 열은 기존 값이 비어 있을 때만 채운다(다른 출처의 값 보존).
 * 같은 묶음 안의 중복 키는 마지막 행을 쓴다. 이미 트랜잭션 안이면 그 트랜잭션에 포함된다.
 */
export async function upsertRows<T extends CollectionTable>(repo: Repository, table: T, rows: Partial<RowTypes[T]>[], options: { fill?: string[] } = {}): Promise<number> {
  const spec: TableSpec = COLLECTION_TABLES[table];
  const columns = Object.keys(spec.columns);
  const unique = new Map<string, Partial<RowTypes[T]>>();
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    for (const k of spec.key) if (r[k] === undefined || r[k] === null || r[k] === '') throw new Error(`${table}: 키 ${k} 누락`);
    unique.set(JSON.stringify(spec.key.map(k => r[k])), row);
  }
  const list = [...unique.values()];
  if (!list.length) return 0;
  const fill = new Set(options.fill || []);
  const updates = columns.filter(c => !spec.key.includes(c)).map(c => fill.has(c) ? `"${c}"=COALESCE(${table}."${c}",excluded."${c}")` : `"${c}"=excluded."${c}"`);
  const conflict = updates.length ? `DO UPDATE SET ${updates.join(',')}` : 'DO NOTHING';
  const work = async () => {
    for (let start = 0; start < list.length; start += 200) {
      const batch = list.slice(start, start + 200);
      const values = batch.flatMap(row => columns.map(c => encode(spec.columns[c], (row as Record<string, unknown>)[c])));
      await repo.run(`INSERT INTO ${table}(${columns.map(c => `"${c}"`).join(',')}) VALUES${batch.map(() => `(${columns.map(() => '?').join(',')})`).join(',')} ON CONFLICT(${spec.key.join(',')}) ${conflict}`, ...values);
    }
  };
  if (repo.inTransaction()) await work(); else await repo.transaction(work);
  return list.length;
}

/** 조건은 열=값(배열이면 IN)으로만 받는다. 열 이름은 표 정의에 있는 것만 허용한다. */
export async function selectRows<T extends CollectionTable>(repo: Repository, table: T, where: Partial<Record<string, unknown>> = {}): Promise<RowTypes[T][]> {
  const spec: TableSpec = COLLECTION_TABLES[table];
  const clauses: string[] = [], args: unknown[] = [];
  for (const [column, value] of Object.entries(where)) {
    if (!(column in spec.columns)) throw new Error(`${table}: 알 수 없는 열 ${column}`);
    if (Array.isArray(value)) { if (!value.length) return []; clauses.push(`"${column}" IN (${value.map(() => '?').join(',')})`); args.push(...value); }
    else { clauses.push(`"${column}"=?`); args.push(value); }
  }
  const rows = await repo.all(`SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${spec.key.map(k => `"${k}"`).join(',')}`, ...args);
  // 삭제한 체계(예: 마이그레이션 008 전의 laser) 행은 무시한다. '*'는 국가 단위 등급이다.
  const known = !('system' in spec.columns) ? rows : rows.filter(r => r.system === '*' || (SYSTEM_KEYS as readonly string[]).includes(r.system));
  return known.map(r => decode(table, r));
}

export async function deleteRows(repo: Repository, table: CollectionTable, where: Record<string, unknown>) {
  const spec: TableSpec = COLLECTION_TABLES[table];
  const entries = Object.entries(where);
  if (!entries.length) throw new Error('조건 없는 삭제는 허용하지 않습니다');
  for (const [c] of entries) if (!(c in spec.columns)) throw new Error(`${table}: 알 수 없는 열 ${c}`);
  await repo.run(`DELETE FROM ${table} WHERE ${entries.map(([c]) => `"${c}"=?`).join(' AND ')}`, ...entries.map(([, v]) => v));
}

/** DB의 비중을 기본값 위에 덮어쓴다. 표가 비어 있어도 요구서 기본값으로 계산한다. */
export async function readWeights(repo: Repository): Promise<Record<string, number>> {
  const rows = await selectRows(repo, 'weights');
  return { ...DEFAULT_WEIGHTS, ...Object.fromEntries(rows.filter(r => Number.isFinite(r.weight)).map(r => [r.factor, r.weight])) };
}

/** 한 체계의 점수 계산 자료를 한 번에 읽는다. 국가별 입력은 inputsFor로 나눈다. */
export async function scoringBundle(repo: Repository, system: SystemKey) {
  const [tiers, domestic, signals, inventory, budgets, neighbors, consumption, capacity, links, weights] = await Promise.all([
    selectRows(repo, 'export_tiers', { system: [system, '*'] }), selectRows(repo, 'domestic_capability', { system }), selectRows(repo, 'signals', { system }),
    selectRows(repo, 'inventory', { system }), selectRows(repo, 'budgets'), selectRows(repo, 'neighbors'), selectRows(repo, 'consumption', { system }),
    selectRows(repo, 'supplier_capacity'), selectRows(repo, 'system_links', { system }), readWeights(repo),
  ]);
  return { system, tiers, domestic, signals, inventory, budgets, neighbors, consumption, capacity, links, weights };
}
export type ScoringBundle = Awaited<ReturnType<typeof scoringBundle>>;
export function inputsFor(bundle: ScoringBundle, country: string): ScoreInputs {
  const near = bundle.neighbors.filter(n => n.country === country);
  const nearIds = new Set(near.map(n => n.neighbor));
  return {
    country, system: bundle.system, weights: bundle.weights,
    tier: bundle.tiers.find(t => t.country === country && t.system === bundle.system) || bundle.tiers.find(t => t.country === country && t.system === '*') || null,
    domestic: bundle.domestic.find(d => d.country === country) || null,
    signals: bundle.signals.filter(s => s.country === country),
    inventory: bundle.inventory.filter(i => i.country === country),
    budgets: bundle.budgets.filter(b => b.country === country),
    neighbors: near,
    neighborSignals: bundle.signals.filter(s => nearIds.has(s.country)),
    neighborBudgets: bundle.budgets.filter(b => nearIds.has(b.country)),
    consumption: bundle.consumption.filter(c => c.user_country === country),
    capacity: bundle.capacity, links: bundle.links,
    systemSignals: bundle.signals,
  };
}
export async function scoringInputs(repo: Repository, country: string, system: SystemKey) { return inputsFor(await scoringBundle(repo, system), country); }
