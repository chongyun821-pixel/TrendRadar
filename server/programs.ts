import { z } from 'zod';
import { resolveCountry, resolveSystem } from '../shared/data';
import { catalogCountry, catalogMetadata } from '../shared/countries';
import { PROJECT_STAGES, type Project, type ProgramRecord } from '../shared/types';
import { COMMITTED_STAGES as COMMITTED } from '../shared/forecast';
import { execution } from './execution';
import { now } from './store';
import { normalizationTool } from './normalization';
import { submitResearch } from './research';
import { preservedSource } from './equipment';

const year = z.number().int().min(1800).max(2300);
const ESTIMABLE = ['qty', 'amount', 'decisionYear', 'contractYear', 'deliveryStart', 'deliveryEnd', 'covers'] as const;
const STAGE_ALIASES: Record<string, Project['stage']> = { 검토: 'consideration', 계획: 'plan', 입찰: 'tender', 선정: 'selected', 우선협상: 'selected', 계약: 'contract', 인도: 'delivery', '인도 중': 'delivery', 완료: 'completed', 취소: 'cancelled' };
const evidenceItem = z.object({ filePath: z.string().min(1), quote: z.string().min(1), title: z.string().optional() });

/**
 * 진행 중, 선정 전 사업 하나를 원문 근거와 함께 저장, 갱신한다(record.projects, 같은 id는 갱신).
 * save_equipment처럼 보존 원문, 인용문을 검사하고 정제(normalize)→사전 검증(validate)→반영(apply)과 변경, 예측 이력을 거친다.
 * 공급자가 정해진 단계(selected, contract, delivery, completed)는 교체 수요를 채운 것으로 계산되어 사업 기회에서 빠진다.
 */
export async function saveProgram(raw: Record<string, unknown>) {
  const a = z.object({
    country: z.string(), system: z.string(), id: z.string().trim().min(1).max(80),
    stage: z.string().transform(s => STAGE_ALIASES[s.trim()] || s.trim().toLowerCase()).pipe(z.enum(PROJECT_STAGES)),
    supplier: z.string().trim().default(''), text: z.string().trim().min(1), model: z.string().trim().min(1).optional(),
    qty: z.number().int().nonnegative().optional(), amount: z.number().nonnegative().optional(), currency: z.string().trim().toUpperCase().optional(),
    decisionYear: year.optional(), contractYear: year.optional(), deliveryStart: year.optional(), deliveryEnd: year.optional(),
    coversPct: z.number().int().min(0).max(100).optional(), reserve: z.string().trim().min(1).optional(),
    estimated: z.string().optional().transform(s => (s ? s.split(',').map(x => x.trim()).filter(Boolean) : [])).pipe(z.array(z.enum(ESTIMABLE))),
    filePath: z.string().min(1), quote: z.string().min(1), title: z.string().optional(),
    evidence: z.string().optional().transform(s => (s ? JSON.parse(s) : [])).pipe(z.array(evidenceItem).max(5)),
  }).parse(raw);
  const ctx = await execution(), repo = ctx.repo, data = await repo.data();
  const country = resolveCountry(a.country), system = resolveSystem(a.system);
  if (!country || !system || !data.systems[system]) throw new Error('국가와 현재 지원하는 무기체계를 확인하세요');
  const items = [{ filePath: a.filePath, quote: a.quote, title: a.title }, ...a.evidence];
  const sources: Record<string, unknown> = {}, evidence: { path: string; sourceId: string; quote: string }[] = [];
  for (const item of items) {
    const s = await preservedSource(item.filePath, item.quote, item.title, 'program');
    sources[s.sourceId] = s.source;
    evidence.push({ path: 'projects', sourceId: s.sourceId, quote: item.quote });
  }
  const row = await repo.one('SELECT * FROM records WHERE country=? AND system=?', country, system);
  const record: ProgramRecord = row ? JSON.parse(row.data) : { id: `${country}-${system}`, country, system, batches: [], src: [] };
  const previous = (record.projects || []).find(p => p.id === a.id);
  const fields = Object.fromEntries(Object.entries({ model: a.model, qty: a.qty, amount: a.amount, currency: a.currency, decisionYear: a.decisionYear, contractYear: a.contractYear,
    deliveryStart: a.deliveryStart, deliveryEnd: a.deliveryEnd, covers: a.coversPct == null ? undefined : a.coversPct / 100, reserve: a.reserve }).filter(([, v]) => v !== undefined));
  // 새로 확인한 값은 추정 표시를 지우고, estimated로 넘긴 필드만 추정으로 남긴다
  const est = new Set((previous?.est || []).filter(f => !(f in fields)));
  for (const f of a.estimated) est.add(f);
  const ids = Object.keys(sources);
  const project: Project = { ...previous, id: a.id, buyer: country, supplier: a.supplier || previous?.supplier || '', stage: a.stage, text: a.text, ...fields,
    est: [...est], asOf: now().slice(0, 10), src: [...new Set([...(previous?.src || []), ...ids])] } as Project;
  record.projects = previous ? record.projects!.map(p => (p === previous ? project : p)) : [...(record.projects || []), project];
  record.src = [...new Set([...record.src, ...ids])];
  // 새 기록은 보유 장비 미확인(batches: [])으로 만든다. 빈 batches도 변경 필드라 같은 원문을 근거로 단다(보유 자료는 save_equipment로 따로 채운다)
  if (!row) evidence.push({ ...evidence[0], path: 'batches' });
  const catalog = catalogCountry(country);
  const input = { record, expectedVersion: row?.version || 0, replaceFields: ['projects'], sources, evidence,
    reason: previous ? `보존 원문에 근거해 사업 ${a.id} 현황 갱신(${previous.stage}→${a.stage})` : `보존 원문에 근거해 사업 ${a.id} 등록`, asOf: now().slice(0, 10),
    ...(!data.countries[country] && catalog ? { countryMeta: catalogMetadata(catalog) } : {}) };
  const normalized: any = await normalizationTool('normalize_procurement_data', { payload: JSON.stringify(input) });
  if (!normalized.ok) return { error: '사업 정제 오류를 확인하세요', errors: normalized.errors, conflicts: normalized.conflicts, repair: normalized.repair };
  await submitResearch(normalized.payload, { dryRun: true });
  const saved: any = await submitResearch(normalized.payload, { idempotent: true });
  return { ...saved, note: COMMITTED.includes(project.stage) ? '공급자가 정해진 사업은 기존 전력 교체 수요를 채운 것으로 계산한다. 다음 교체는 인도 연도 + 설계 수명의 후속 주기(추정)다' : '선정 전 사업은 사업 기회로 남는다' };
}
