/** 수집 스크립트 공통: 인자, 재시도 fetch, 국가명→국가 ID, 출처 기록, 적재(드라이런 지원). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, repository, type Repository } from '../../server/store';
import { upsertRows, type CollectionTable, type RowTypes } from '../../server/collection';

export type Fetch = typeof fetch;
export interface IngestOptions {
  dryRun?: boolean;
  /** 네트워크 대신 읽을 로컬 파일(오프라인 재처리·테스트용) */
  file?: string;
  fetch?: Fetch;
  repo?: Repository;
  /** 기준 연도. 기본값은 현재 연도 */
  year?: number;
  /** 수집 시각(ISO). 테스트에서 고정한다 */
  now?: string;
  log?: (line: string) => void;
  args?: Record<string, string | boolean>;
}
export interface SourceInfo { id: string; title: string; url: string; confidence: number; publishedAt?: string | null }
export type TableRows = { [T in CollectionTable]?: Partial<RowTypes[T]>[] };
export interface IngestResult { source: SourceInfo; rows: TableRows; written: Partial<Record<CollectionTable, number>>; dryRun: boolean; notes: string[] }

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    if (m[2] !== undefined) out[m[1]] = m[2];
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[m[1]] = argv[++i];
    else out[m[1]] = true;
  }
  return out;
}

/** 시간 제한·재시도(5xx·네트워크 오류) fetch. 4xx는 바로 실패한다(인증키 필요 여부를 그대로 보여주기 위해) */
export async function fetchRetry(fetchImpl: Fetch, url: string, init: RequestInit = {}, { retries = 3, timeoutMs = 60000 } = {}): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, headers: { 'User-Agent': 'Mozilla/5.0 (procurement-radar ingest)', ...(init.headers || {}) }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;
      if (res.status < 500) throw Object.assign(new Error(`HTTP ${res.status} ${url}`), { status: res.status, fatal: true });
      last = new Error(`HTTP ${res.status} ${url}`);
    } catch (e: any) { if (e?.fatal) throw e; last = e; }
    if (attempt < retries) await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw last instanceof Error ? last : new Error(String(last));
}
export async function readInput(opts: IngestOptions, url: string, init?: RequestInit): Promise<Uint8Array> {
  if (opts.file) return new Uint8Array(readFileSync(opts.file));
  const res = await fetchRetry(opts.fetch || fetch, url, init);
  return new Uint8Array(await res.arrayBuffer());
}
export const text = (bytes: Uint8Array, encoding = 'utf-8') => new TextDecoder(encoding).decode(bytes);

/** RFC 4180 CSV(따옴표·줄바꿈 포함) */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) { if (c === '"') { if (input[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
    else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// --- 국가 ID(앱 지도와 같은 ADM0_A3) ---
const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/\(.*?\)|\*/g, ' ').replace(/&/g, 'and').replace(/[^a-z0-9가-힣]+/g, ' ').trim();
/** Natural Earth 1:110m에 없는 소국과 출처별 표기 차이 */
const EXTRA_NAMES: Record<string, string> = {
  'south korea': 'KOR', 'korea south': 'KOR', 'korea republic of': 'KOR', 'republic of korea': 'KOR', 'korea rep': 'KOR', 'north korea': 'PRK', 'korea north': 'PRK', 'korea dem people s rep': 'PRK', "democratic people's republic of korea": 'PRK',
  'russia': 'RUS', 'russian federation': 'RUS', 'soviet union': 'RUS', 'ussr': 'RUS', 'united states': 'USA', 'usa': 'USA', 'united states of america': 'USA', 'uk': 'GBR', 'united kingdom': 'GBR',
  'turkiye': 'TUR', 'turkey': 'TUR', 'czechia': 'CZE', 'czech republic': 'CZE', 'czechoslovakia': 'CZE', 'viet nam': 'VNM', 'vietnam': 'VNM', 'iran': 'IRN', 'iran islamic rep': 'IRN', 'syria': 'SYR', 'syrian arab republic': 'SYR', 'laos': 'LAO', 'lao pdr': 'LAO',
  'dr congo': 'COD', 'congo dr': 'COD', 'congo dem rep': 'COD', 'democratic republic of the congo': 'COD', 'drc': 'COD', 'zaire': 'COD', 'congo': 'COG', 'congo rep': 'COG', 'congo republic': 'COG', 'congo republic of': 'COG', 'republic of the congo': 'COG',
  'myanmar': 'MMR', 'burma': 'MMR', 'cote d ivoire': 'CIV', 'ivory coast': 'CIV', 'uae': 'ARE', 'united arab emirates': 'ARE', 'eswatini': 'SWZ', 'swaziland': 'SWZ', 'north macedonia': 'MKD', 'macedonia': 'MKD', 'macedonia fyr': 'MKD',
  'bosnia herzegovina': 'BIH', 'bosnia and herzegovina': 'BIH', 'timor leste': 'TLS', 'east timor': 'TLS', 'taiwan': 'TWN', 'palestine': 'PSE', 'brunei': 'BRN', 'brunei darussalam': 'BRN', 'gambia': 'GMB', 'gambia the': 'GMB', 'bahamas': 'BHS', 'bahamas the': 'BHS',
  'kosovo': 'KOS', 'egypt arab rep': 'EGY', 'yemen rep': 'YEM', 'yemen': 'YEM', 'north yemen': 'YEM', 'venezuela rb': 'VEN', 'venezuela': 'VEN', 'bolivia': 'BOL', 'tanzania': 'TZA', 'moldova': 'MDA', 'kyrgyz republic': 'KGZ', 'slovak republic': 'SVK', 'yugoslavia': 'SRB', 'serbia': 'SRB',
  'central african republic': 'CAF', 'car': 'CAF', 'south sudan': 'SSD', 'sudan': 'SDN', 'somalia': 'SOM', 'libya': 'LBY', 'east germany': 'DEU', 'west germany': 'DEU', 'germany': 'DEU', 'cabo verde': 'CPV', 'cape verde': 'CPV',
  'singapore': 'SGP', 'bahrain': 'BHR', 'malta': 'MLT', 'mauritius': 'MUS', 'maldives': 'MDV', 'seychelles': 'SYC', 'comoros': 'COM', 'barbados': 'BRB', 'antigua and barbuda': 'ATG', 'saint lucia': 'LCA', 'grenada': 'GRD', 'tonga': 'TON', 'samoa': 'WSM',
  'andorra': 'AND', 'liechtenstein': 'LIE', 'monaco': 'MCO', 'san marino': 'SMR', 'saint kitts and nevis': 'KNA', 'saint vincent and the grenadines': 'VCT', 'dominica': 'DMA', 'micronesia fed sts': 'FSM', 'sao tome and principe': 'STP', 'hong kong sar china': 'HKG',
};
/** GDELT(CAMEO) 국가 코드 중 ISO와 다른 것 */
export const CAMEO_TO_ID: Record<string, string> = { ROM: 'ROU', TMP: 'TLS', ZAR: 'COD', SER: 'SRB', BUR: 'MMR', DRC: 'COD' };

let index: { byName: Map<string, string>; ids: Set<string>; ko: Map<string, string> } | null = null;
export function countryIndex() {
  if (index) return index;
  const geo = JSON.parse(readFileSync(join(PROJECT_ROOT, 'data/ne_110m_admin_0_countries.geojson'), 'utf8'));
  const byName = new Map<string, string>(), ids = new Set<string>(), ko = new Map<string, string>();
  for (const f of geo.features) {
    const p = f.properties, id = p.ADM0_A3;
    ids.add(id); if (p.NAME_KO) ko.set(id, p.NAME_KO);
    for (const n of [p.NAME, p.NAME_LONG, p.ADMIN, p.FORMAL_EN, p.NAME_KO, p.NAME_EN, p.NAME_SORT]) if (n) byName.set(fold(String(n)), id);
    byName.set(fold(id), id); if (p.ISO_A3 && p.ISO_A3 !== '-99') byName.set(fold(p.ISO_A3), id);
  }
  for (const [n, id] of Object.entries(EXTRA_NAMES)) { byName.set(fold(n), id); ids.add(id); }
  return index = { byName, ids, ko };
}
/** 국가명·ISO3 → 국가 ID. 비국가 행위자(반군·국제기구 등)와 알 수 없는 이름은 null */
export function countryId(name: string | null | undefined): string | null {
  if (!name) return null;
  if (/\*|rebels?|unknown|united nations|african union|nato|hezbollah|houthi|\brsf\b|house of representatives/i.test(name)) return null;
  const { byName } = countryIndex();
  return byName.get(fold(name)) ?? null;
}

export const sourceRow = (s: SourceInfo, collectedAt: string) => ({ t: s.title, u: s.url, y: Number(collectedAt.slice(0, 4)), publishedAt: s.publishedAt ?? null, collectedAt, kind: 'original' as const });
/** 모든 행에 source_id·confidence·collected_at을 채운다(행에 이미 있으면 유지) */
export function stamp<T extends Record<string, any>>(rows: T[], source: SourceInfo, collectedAt: string, table?: CollectionTable): T[] {
  if (table === 'weights') return rows;
  return rows.map(r => ({ source_id: source.id, confidence: source.confidence, collected_at: collectedAt, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) } as unknown as T));
}

/** 출처 행과 수집 행을 한 트랜잭션으로 적재한다. dryRun이면 DB를 열지 않는다. fill은 표별로 '비어 있을 때만 채울' 열 */
export async function load(opts: IngestOptions, source: SourceInfo, rows: TableRows, notes: string[] = [], fill: Partial<Record<CollectionTable, string[]>> = {}): Promise<IngestResult> {
  const collectedAt = opts.now || new Date().toISOString();
  const stamped: TableRows = {};
  for (const [t, list] of Object.entries(rows) as [CollectionTable, any[]][]) (stamped as any)[t] = stamp(list, source, collectedAt, t);
  const written: Partial<Record<CollectionTable, number>> = {};
  if (opts.dryRun) {
    for (const [t, list] of Object.entries(stamped)) written[t as CollectionTable] = 0, notes.push(`${t}: ${list!.length}행(드라이런, 적재 안 함)`);
    return { source, rows: stamped, written, dryRun: true, notes };
  }
  const repo = opts.repo || repository();
  await repo.transaction(async () => {
    await repo.run('INSERT INTO sources(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', source.id, JSON.stringify(sourceRow(source, collectedAt)));
    for (const [t, list] of Object.entries(stamped) as [CollectionTable, any[]][]) written[t] = await upsertRows(repo, t, list, { fill: fill[t] });
  });
  return { source, rows: stamped, written, dryRun: false, notes };
}

export function summarize(result: IngestResult) {
  const sample = Object.fromEntries(Object.entries(result.rows).map(([t, list]) => [t, { rows: list!.length, sample: list!.slice(0, 3) }]));
  return { source: result.source, dryRun: result.dryRun, written: result.written, tables: sample, notes: result.notes };
}

export const isMain = (url: string) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;
/** CLI 진입점: --dry-run, --file <경로>, --year <연도>. 결과 요약을 JSON으로 출력한다 */
export async function runCli(name: string, job: (opts: IngestOptions) => Promise<IngestResult>) {
  const args = parseArgs(process.argv.slice(2));
  const opts: IngestOptions = { dryRun: !!args['dry-run'], file: typeof args.file === 'string' ? args.file : undefined, year: args.year ? Number(args.year) : undefined, args, log: line => console.error(`[${name}] ${line}`) };
  try {
    const result = await job(opts);
    console.log(JSON.stringify(summarize(result), null, 2));
  } catch (e: any) { console.error(`[${name}] 실패: ${e?.message || e}`); process.exitCode = 1; }
  finally {
    // 작업이 연 저장소만 닫는다(드라이런 중 읽기만 한 경우 포함)
    const open = (globalThis as typeof globalThis & { __radarRepositories?: Map<string, Repository> }).__radarRepositories;
    for (const repo of open?.values() || []) await repo.close().catch(() => {});
  }
}
export const baseYear = (opts: IngestOptions) => opts.year || Number((opts.now || new Date().toISOString()).slice(0, 4));
