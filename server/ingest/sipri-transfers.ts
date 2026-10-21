/**
 * SIPRI 무기 이전 DB → signals(계약·인도 단계) + inventory(인도 누적 보유 추정).
 * 공개 웹앱(armstransfers.sipri.org)이 쓰는 CSV 내보내기 백엔드를 쓴다. 인증키 불필요, 문서화되지 않은 경로라 바뀔 수 있다.
 * CLI: npm run ingest:sipri-transfers -- [--dry-run] [--year 2025] [--since 1985] [--file 내보낸.csv]
 */
import type { InventoryRow, SignalRow, SystemKey } from '../../shared/types';
import { baseYear, countryId, load, parseCsv, readInput, text, type IngestOptions } from './common';

export const SIPRI_TRANSFERS_URL = 'https://atbackend.sipri.org/api/p/trades/trade-register-csv/?output=csv';
export const SIPRI_TRANSFERS_SOURCE = { id: 'sipri_transfers', title: 'SIPRI Arms Transfers Database (trade register)', url: 'https://armstransfers.sipri.org/ArmsTransfer/TransferRegister', confidence: 1 };
/** 보유 현황은 이전 기록을 누적한 추정치라 신뢰도를 낮춘다(요구서 2장: 빈칸은 SIPRI 누적 추정) */
export const INVENTORY_CONFIDENCE = 0.7;
/** systems.designLife와 같은 값(스크립트는 앱 데이터를 읽지 않고 실행되므로 고정) */
export const DESIGN_LIFE: Record<SystemKey, number> = { sph: 35, ifv: 35, sam: 30, mrl: 30, frigate: 30, ssk: 30, laser: 20 };

export function sipriBody(orderFrom: number, orderTo: number) {
  return { filters: [{ field: 'Order year', oldField: '', condition: 'contains', value1: orderFrom, value2: orderTo, listData: [] }], logic: 'AND' };
}

/** SIPRI 무기 설명 → 앱 체계. 함정 탑재 대공미사일·자주 박격포·견인포 등은 제외 */
export function classifyWeapon(description: string, designation = '', comments = ''): SystemKey | null {
  const d = description.toLowerCase().trim();
  if (/laser|directed.energy/i.test(`${d} ${designation}`) || /\b(dragonfire|iron beam|천광)\b/i.test(`${designation} ${comments}`)) return 'laser';
  if (d === 'self-propelled gun') return 'sph';
  if (d === 'infantry fighting vehicle') return 'ifv';
  if (d === 'multiple rocket launcher' || d === 'self-propelled mrl') return 'mrl';
  if (['surface-to-air missile system', 'mobile surface-to-air missile system', 'self-propelled air-defence system', 'anti-ballistic missile system', 'sam system', 'mobile sam system'].includes(d)) return 'sam';
  if (d === 'frigate' || d === 'patrol ship/frigate') return 'frigate';
  if (d === 'submarine') return 'ssk';
  return null;
}
const num = (s: string | undefined) => { const n = Number(String(s ?? '').replace(/[^0-9.]/g, '')); return s && /\d/.test(s) && Number.isFinite(n) ? n : null; };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** 비고의 "delivery planned 2027-2029"/"by 2028"에서 마지막 인도 예정 연도 */
export function plannedEnd(comments: string): number | null {
  const m = /deliver(?:y|ies)\s+planned\s+(?:by\s+|from\s+|in\s+)?(\d{4})(?:\s*-\s*(\d{4}))?/i.exec(comments);
  return m ? Number(m[2] || m[1]) : null;
}
/** 비고의 "$667 m", "($1.7 b)" → 백만 달러 */
export function dealValue(comments: string): number | null {
  const m = /\$(\d+(?:\.\d+)?)(?:-\d+(?:\.\d+)?)?\s*(m|b)\b/i.exec(comments);
  return m ? Math.round(Number(m[1]) * (m[2].toLowerCase() === 'b' ? 1000 : 1)) : null;
}

export interface SipriTrade { recipient: string; supplier: string; orderYear: number; ordered: number | null; designation: string; description: string; delivered: number | null; deliveryYears: number[]; status: string; comments: string }
export function parseTradeRegister(csv: string): SipriTrade[] {
  const rows = parseCsv(csv);
  const head = rows.findIndex(r => r[0] === 'Recipient' && r[1] === 'Supplier');
  if (head < 0) throw new Error('SIPRI CSV 머리글(Recipient,Supplier)을 찾지 못했습니다');
  const h = rows[head], col = (name: string) => h.indexOf(name);
  const c = { rec: col('Recipient'), sup: col('Supplier'), year: col('Year of order'), ordered: col('Number ordered'), des: col('Weapon designation'), desc: col('Weapon description'), delivered: col('Deliveries in the Year Range'), years: col('Year(s) of delivery'), status: col('status'), comments: col('Comments') };
  return rows.slice(head + 1).filter(r => r.length > c.comments && r[c.rec]).map(r => ({
    recipient: r[c.rec], supplier: r[c.sup], orderYear: Number(r[c.year]), ordered: num(r[c.ordered]), designation: r[c.des], description: r[c.desc],
    delivered: num(r[c.delivered]), deliveryYears: (r[c.years] || '').split(/[;,]\s*/).map(Number).filter(Boolean), status: r[c.status], comments: r[c.comments] || '',
  }));
}

export function normalizeTrades(trades: SipriTrade[], base: number) {
  const signals: Partial<SignalRow>[] = [], inventory: Partial<InventoryRow>[] = [], unknown = new Set<string>();
  for (const t of trades) {
    const system = classifyWeapon(t.description, t.designation, t.comments);
    if (!system) continue;
    const country = countryId(t.recipient);
    if (!country) { unknown.add(t.recipient); continue; }
    const id = `sipri:${country}:${slug(t.supplier)}:${slug(t.designation)}:${t.orderYear}`;
    const lastDelivery = t.deliveryYears.length ? Math.max(...t.deliveryYears) : null;
    const done = t.ordered != null && t.delivered != null && t.delivered >= t.ordered;
    if (t.orderYear >= base - 5) signals.push({
      id, country, system, model: t.designation, supplier: countryId(t.supplier) ?? t.supplier, stage: lastDelivery ? 'delivery' : 'contract',
      quantity: t.ordered, value_usd_m: dealValue(t.comments), expected_year: plannedEnd(t.comments) ?? (done ? lastDelivery : null),
      published_at: String(t.orderYear), url: SIPRI_TRANSFERS_SOURCE.url, note: [t.description, t.status !== 'New' ? t.status : '', t.comments].filter(Boolean).join(' | ').slice(0, 500),
    });
    if (lastDelivery) {
      const life = DESIGN_LIFE[system];
      // 중고 도입은 남은 수명이 짧아 설계 수명의 절반으로 본다(추정)
      const serviceLife = /second hand/i.test(t.status) ? Math.round(life / 2) : life;
      inventory.push({ id, country, system, model: t.designation, quantity: t.delivered ?? t.ordered, delivered_year: lastDelivery, service_life: serviceLife, retire_year: lastDelivery + serviceLife, supplier: countryId(t.supplier) ?? t.supplier, confidence: INVENTORY_CONFIDENCE });
    }
  }
  return { signals, inventory, unknown: [...unknown].sort() };
}

export async function ingestSipriTransfers(opts: IngestOptions = {}) {
  const base = baseYear(opts), since = Number(opts.args?.since) || base - 40;
  const bytes = await readInput(opts, SIPRI_TRANSFERS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sipriBody(since, base)) });
  let csv = text(bytes);
  if (csv.trimStart().startsWith('{')) csv = text(Buffer.from(JSON.parse(csv).bytes, 'base64'), 'latin1'); // 백엔드는 {bytes: base64(CSV, Latin-1)}로 준다
  const trades = parseTradeRegister(csv);
  const { signals, inventory, unknown } = normalizeTrades(trades, base);
  opts.log?.(`거래 ${trades.length}건 → signals ${signals.length}, inventory ${inventory.length}`);
  const notes = [`주문 연도 ${since}~${base}`, ...(unknown.length ? [`국가 ID 미매칭(비국가 행위자 포함): ${unknown.join(', ')}`] : [])];
  // 보유 추정은 연구 결과(높은 신뢰도)가 있으면 덮어쓰지 않도록 수량·연도를 비어 있을 때만 채운다
  return load(opts, SIPRI_TRANSFERS_SOURCE, { signals, inventory }, notes, { inventory: ['quantity', 'service_life', 'retire_year'] });
}
