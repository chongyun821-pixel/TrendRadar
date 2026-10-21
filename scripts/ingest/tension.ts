/**
 * 인접국·긴장도 산출 작업 → neighbors. 육상 국경(공유 꼭짓점)·해상 인접(400km)·GDELT 경쟁국 쌍마다 shared/tension.ts로 0~100 긴장도를 계산한다.
 * 순서: ucdp·gdelt·sipri-milex·sipri-transfers 적재 후 매월 실행. 사용: npm run ingest:tension -- [--dry-run] [--as-of 2026-09]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NeighborRow } from '../../shared/types';
import { computeTension, geoFeatures, landNeighbors, rivals, seaNeighbors, type Alliance, type Dispute } from '../../shared/tension';
import { PROJECT_ROOT, repository } from '../../server/store';
import { selectRows } from '../../server/collection';
import { isMain, load, runCli, type IngestOptions } from './common';

export const TENSION_SOURCE = { id: 'tension_v1', title: '인접국 긴장도 산출 v1(docs/데이터수집요구서.md 5장)', url: 'docs/데이터수집요구서.md', confidence: 1 };
const readJson = (p: string) => JSON.parse(readFileSync(join(PROJECT_ROOT, p), 'utf8'));

export async function ingestTension(opts: IngestOptions = {}) {
  const now = opts.now || new Date().toISOString();
  const asOf = typeof opts.args?.['as-of'] === 'string' ? opts.args['as-of'] : new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7);
  const base = Number(asOf.slice(0, 4));
  const repo = opts.repo || repository();
  const [events, budgets, signals] = await Promise.all([selectRows(repo, 'pair_events'), selectRows(repo, 'budgets'), selectRows(repo, 'signals')]);
  const features = geoFeatures(readJson('data/ne_110m_admin_0_countries.geojson'));
  const disputes: Dispute[] = readJson('data/reference/territorial-disputes.json').disputes;
  const alliances: Alliance[] = readJson('data/reference/alliances.json').alliances;
  const land = landNeighbors(features);
  const pairs = new Map<string, NeighborRow['kind']>();
  for (const p of land) pairs.set(p.join('|'), 'land');
  for (const s of seaNeighbors(features, undefined, land)) pairs.set(s.pair.join('|'), 'sea');
  const since = `${base - 5}-${asOf.slice(5, 7)}`;
  for (const p of rivals(events, 3, 50, since)) if (!pairs.has(p.join('|'))) pairs.set(p.join('|'), 'rival');
  const rows: Partial<NeighborRow>[] = [];
  for (const [key, kind] of pairs) {
    const [a, b] = key.split('|');
    for (const [country, neighbor] of [[a, b], [b, a]]) {
      const t = computeTension({ country, neighbor, base, events, budgets, signals, disputes, alliances }, asOf);
      rows.push({ country, neighbor, kind, tension: t.tension, components: t.components, computed_at: now, confidence: t.confidence });
    }
  }
  const notes = [`기준 ${asOf}, 쌍 ${pairs.size}개(육상 ${[...pairs.values()].filter(k => k === 'land').length}, 해상 ${[...pairs.values()].filter(k => k === 'sea').length}, 경쟁국 ${[...pairs.values()].filter(k => k === 'rival').length})`];
  if (!events.length) notes.push('pair_events가 비어 있어 충돌·이벤트 요소가 0입니다. ucdp·gdelt를 먼저 실행하세요');
  return load(opts, TENSION_SOURCE, { neighbors: rows }, notes);
}

if (isMain(import.meta.url)) await runCli('tension', ingestTension);
