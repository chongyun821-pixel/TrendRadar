import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { resolveCountry, resolveSystem } from '../shared/data';
import { catalogCountry, catalogMetadata, countryKey } from '../shared/countries';
import { execution } from './execution';
import { hash, now } from './store';
import { normalizationTool } from './normalization';
import { submitResearch } from './research';
import type { ProgramRecord } from '../shared/types';

/** 현재 대화에 보존한 원문 파일과 인용문을 검사하고 실제 메타데이터로 출처 객체를 만든다(검색 요약은 거절) */
export async function preservedSource(filePath: string, quote: string, title: string | undefined, prefix: string) {
  const ctx = await execution(), repo = ctx.repo;
  const path = repo.path(ctx.conversationId, filePath, true);
  const sourceFile = await repo.one("SELECT * FROM artifacts WHERE conversation_id=? AND path=? AND kind IN ('original','attachment','extracted') AND status='ok'", ctx.conversationId, repo.storedPath(path));
  if (!sourceFile) throw new Error('현재 대화에 보존한 원문 파일을 지정하세요. 검색 요약은 사용할 수 없습니다');
  const bytes = readFileSync(path);
  if (hash(bytes) !== sourceFile.hash || !bytes.toString('utf8').includes(quote)) throw new Error('원문 해시 또는 인용문이 일치하지 않습니다');
  const url: string = sourceFile.url || `attachment://${sourceFile.id}`;
  const sourceId = `${prefix}-${hash(`${url}:${sourceFile.hash}`).slice(0, 20)}`;
  const publishedAt: string | null = sourceFile.published_at || null;
  return { sourceId, url, source: { t: title || url, u: url, y: publishedAt ? Number(publishedAt.slice(0, 4)) : 0, publishedAt, collectedAt: sourceFile.collected_at, filePath: sourceFile.name, hash: sourceFile.hash, kind: 'original' as const } };
}

/** 단순 장비 반영도 기존 원문, 정제, 검증, 버전 검사와 변경/예측 이력을 거친다. */
export async function saveEquipment(raw: Record<string, unknown>) {
  const a = z.object({ country: z.string(), system: z.string(), model: z.string().trim().min(1), filePath: z.string().min(1), quote: z.string().min(1),
    introYear: z.number().int().min(1800).max(2300).nullable().optional(), qty: z.number().int().nonnegative().nullable().optional(),
    primary: z.boolean().optional(), status: z.enum(['in_service','retired','planned']).optional(), introYearEstimated: z.boolean().optional(), note: z.string().optional(), title: z.string().optional() }).parse(raw);
  const ctx = await execution(), repo = ctx.repo, data = await repo.data();
  const country = resolveCountry(a.country), system = resolveSystem(a.system);
  if (!country || !system || !data.systems[system]) throw new Error('국가와 현재 지원하는 무기체계를 확인하세요');
  const { sourceId, source, url } = await preservedSource(a.filePath, a.quote, a.title, 'equipment');
  const row = await repo.one('SELECT * FROM records WHERE country=? AND system=?', country, system);
  const record: ProgramRecord = row ? JSON.parse(row.data) : { id: `${country}_${system}`, country, system, batches: [], src: [] };
  const matches = record.batches.filter(b => countryKey(b.model) === countryKey(a.model) && (a.introYear == null || b.introYear == null || b.introYear === a.introYear));
  if (matches.length > 1) throw new Error('같은 장비의 배치가 여러 개입니다. research_procurement로 배치를 확인하고 전체 정제 양식을 사용하세요');
  const previous = matches[0];
  if (previous && a.qty != null && previous.qty != null && a.qty !== previous.qty) throw new Error('기존 수량과 상충합니다. 원문과 배치를 비교한 뒤 전체 정제 양식으로 갱신하세요');
  const est = new Set(previous?.est || []);
  if (a.introYearEstimated) est.add('introYear');
  const batch = { ...previous, model: previous?.model || a.model, introYear: a.introYear ?? previous?.introYear ?? null, qty: a.qty ?? previous?.qty ?? null,
    status: a.status || previous?.status || 'in_service' as const, ...(a.primary != null ? { primary: a.primary } : {}),
    est: [...est], ...(a.note ? { note: a.note } : {}), src: [...new Set([...(previous?.src || []), sourceId])] };
  record.batches = previous ? record.batches.map(b => b === previous ? batch : b) : [...record.batches, batch];
  record.src = [...new Set([...record.src, sourceId])];
  const catalog = catalogCountry(country);
  const input = { record, expectedVersion: row?.version || 0, replaceFields: ['batches'],
    sources: { [sourceId]: source },
    evidence: [{ path: 'batches', sourceId, quote: a.quote }], reason: '보존 원문에 근거해 운용 장비와 도입 이력을 반영', asOf: now().slice(0, 10),
    ...(!data.countries[country] && catalog ? { countryMeta: catalogMetadata(catalog) } : {}) };
  const normalized: any = await normalizationTool('normalize_procurement_data', { payload: JSON.stringify(input) });
  if (!normalized.ok) return { error: '장비 정제 오류를 확인하세요', errors: normalized.errors, conflicts: normalized.conflicts, repair: normalized.repair };
  await submitResearch(normalized.payload, { dryRun: true });
  return submitResearch(normalized.payload, { idempotent: true });
}
