/**
 * 고객 등급 판정 작업 → export_tiers(국가 단위 system='*'와 체계별). 수집된 export_controls·signals·pair_events를 읽어 shared/tiers.ts 규칙을 적용한다.
 * 먼저 data/reference/export-controls.json의 한국 수출통제 목록을 export_controls에 적재한다.
 * 순서: sipri-embargoes·itar·sipri-transfers·ucdp 적재 후 실행. 사용: npm run ingest:tiers -- [--dry-run]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExportControlRow, ExportTierRow, PairEventRow, SignalRow, SystemKey } from '../../shared/types';
import { SYSTEM_KEYS } from '../../shared/types';
import { classifyCountry, type ComponentControl, TIER_KO } from '../../shared/tiers';
import { PROJECT_ROOT, repository } from '../store';
import { selectRows } from '../collection';
import { baseYear, countryIndex, load, type IngestOptions, type IngestResult } from './common';

export const TIER_SOURCE = { id: 'tier_rules_v1', title: '고객 등급 판정 규칙 v1(docs/데이터수집요구서.md 4장)', url: 'docs/데이터수집요구서.md', confidence: 1 };
interface Reference { source: { id: string; url: string; confidence: number }; controls: Partial<ExportControlRow>[]; components: ComponentControl[] }
export const readReference = (): Reference => JSON.parse(readFileSync(join(PROJECT_ROOT, 'data/reference/export-controls.json'), 'utf8'));

export function buildTiers(input: { countries: string[]; controls: ExportControlRow[]; signals: SignalRow[]; events: PairEventRow[]; components: ComponentControl[]; base: number; checkedAt: string }): Partial<ExportTierRow>[] {
  const rows: Partial<ExportTierRow>[] = [];
  const korean = input.signals.filter(s => s.supplier === 'KOR' && (s.stage === 'contract' || s.stage === 'delivery'));
  const war = input.events.filter(e => e.source === 'ucdp' && Number(e.period) >= input.base - 3 && (e.fatalities || 0) > 0);
  const components = SYSTEM_KEYS.map(system => input.components.find(c => c.system === system) || { system, usItar: null });
  for (const country of input.countries) {
    const controls = input.controls.filter(c => c.country === country);
    const deliveries = korean.filter(s => s.country === country);
    const conflicts = war.filter(e => e.country === country || e.counterpart === country);
    const facts = { country, controls, koreanDeliveries: deliveries.length, koreanEvidence: deliveries.map(s => `signals:${s.id}`), conflictParty: conflicts.length > 0, conflictEvidence: conflicts.map(e => `pair_events:${e.source}:${e.country}:${e.counterpart}:${e.period}`) };
    const used = controls.filter(c => c.status === 'active' || c.status === 'partial');
    const confidence = Math.min(1, ...used.map(c => c.confidence ?? 1));
    for (const r of classifyCountry(facts, components)) rows.push({ country, system: r.system, tier: r.tier, tier_reasons: r.record, tier_checked_at: input.checkedAt, confidence });
  }
  return rows;
}

export async function ingestTiers(opts: IngestOptions = {}): Promise<IngestResult> {
  const ref = readReference(), checkedAt = opts.now || new Date().toISOString();
  const manual = await load(opts, { id: ref.source.id, title: '한국 수출통제 대상국(수기 확인 목록)', url: ref.source.url, confidence: ref.source.confidence }, { export_controls: ref.controls });
  const repo = opts.repo || repository();
  await opts.progress?.('등급 판정 자료 읽는 중');
  const [dbControls, signals, events, records] = await Promise.all([selectRows(repo, 'export_controls'), selectRows(repo, 'signals'), selectRows(repo, 'pair_events', { source: 'ucdp' }), repo.all('SELECT DISTINCT country FROM records')]);
  // 드라이런이면 수기 목록이 DB에 없으므로 메모리에서 합친다
  const controls = [...dbControls.filter(c => !ref.controls.some(m => m.id === c.id)), ...(manual.rows.export_controls as ExportControlRow[])];
  const countries = [...new Set([...countryIndex().ids, ...records.map((r: any) => r.country)])].sort();
  const rows = buildTiers({ countries, controls, signals, events, components: ref.components, base: baseYear(opts), checkedAt });
  const tally = ([1, 2, 3] as const).map(t => `${TIER_KO[t]} ${rows.filter(r => r.system === '*' && r.tier === t).length}`).join(', ');
  const notes = [...manual.notes, `국가 ${countries.length}개 판정(국가 단위): ${tally}`, '방산 협정 목록은 아직 수집하지 않아 한국산 인도 이력만으로 수출 가능 여부를 본다', '체계별 미국산 부품 여부는 data/reference/export-controls.json에서 수기로 채운다(현재 미확인)'];
  if (!signals.length) notes.push('signals가 비어 있어 모든 국가가 이력 없음(조건부 수출 가능 이하)으로 판정됨. sipri-transfers를 먼저 실행하세요');
  return load(opts, TIER_SOURCE, { export_tiers: rows }, notes);
}
