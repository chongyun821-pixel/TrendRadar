import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveCountry, resolveSystem } from '../shared/data';
import { execution } from './execution';
import { submissionSchema, submitResearch } from './research';
import type { ToolDef } from './agent';

const S = (description: string) => ({ type: 'string' as const, description });
export const NORMALIZATION_DEFS: ToolDef[] = [
  { name: 'normalize_procurement_data', description: '기존 조달 기록과 새 자료를 정제하고 병합한다. 상충 값은 자동 채택하지 않으며 운영 데이터에는 반영하지 않는다', properties: { payload: S('JSON: record(부분 가능), expectedVersion?, sources, evidence, reason, asOf, replaceFields?(배열 교체), removeFields?(명시적 항목 제거)') }, required: ['payload'] },
  { name: 'validate_research', description: '조사 결과의 형식, 원문 인용, 중복 및 버전을 사전 검사한다. 반영하지 않으며 의미 검토는 별도로 필요하다', properties: { payload: S('정제한 조사 제출 JSON') }, required: ['payload'] },
  { name: 'apply_research', description: '원문 근거와 최신 버전 및 실행 상태를 다시 검사하고 기존 자료와 새 자료를 통합한다. 변경 이력과 예측을 함께 저장한다', properties: { payload: S('검토한 조사 제출 JSON') }, required: ['payload'] },
];
const STAGES: Record<string, string> = { 검토: 'consideration', 계획: 'plan', 입찰: 'tender', 계약: 'contract', 인도: 'delivery', 취소: 'cancelled' };
const ARRAY_FIELDS = ['batches', 'projects', 'signals', 'mro'];
export async function normalizationTool(name: string, a: Record<string, any>): Promise<unknown> {
  const input = JSON.parse(z.string().parse(a.payload));
  if (name === 'validate_research') return submitResearch({ ...input, rulesVersion: input.rulesVersion || 'normalization-v1' }, { dryRun: true });
  if (name === 'apply_research') return submitResearch({ ...input, rulesVersion: input.rulesVersion || 'normalization-v1' }, { idempotent: true });
  const ctx = await execution();
  const original = structuredClone(input);
  const raw = z.record(z.unknown()).parse(input.record) as Record<string, any>;
  const data = await ctx.repo.data();
  const country = resolveCountry(raw.country), system = resolveSystem(raw.system);
  if (!country || !system) throw new Error('지원하는 국가와 무기체계를 지정하세요');
  const row = await ctx.repo.one('SELECT * FROM records WHERE country=? AND system=?', country, system);
  const base = row ? JSON.parse(row.data) : { id: raw.id || `${country}-${system}`, country, system, batches: [], src: [] };
  if (input.expectedVersion != null && input.expectedVersion !== (row?.version || 0)) throw new Error('데이터 버전 충돌: 재조회 후 정제하세요');
  const changes: { path: string; before: unknown; after: unknown }[] = [];
  const conflicts: { path: string; previous: unknown; incoming: unknown }[] = [];
  const normalize = (value: any, path: string): any => {
    if (Array.isArray(value)) return value.map((v, i) => {
      if (typeof v === 'string' && /\.(qty|ratio)$/.test(path)) {
        const numeric = v.trim().replaceAll(',', '').match(/^([0-9]+(?:\.[0-9]+)?)\s*(대|문|척|기|발|개)?$/);
        if (numeric) { changes.push({ path: `${path}.${i}`, before: v, after: Number(numeric[1]) }); return Number(numeric[1]); }
      }
      return normalize(v, `${path}.${i}`);
    });
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, any> = Object.create(null);
    for (const [key, rawValue] of Object.entries(value)) {
      let next: any = normalize(rawValue, `${path}.${key}`);
      if (typeof next === 'string') {
        next = next.trim();
        if (['qty', 'amount', 'introYear', 'year', 'start', 'end', 'deliveryEnd', 'lifeExt', 'covers'].includes(key)) {
          const number = next.replaceAll(',', '').match(/^([0-9]+(?:\.[0-9]+)?)\s*(대|문|척|기|발|개|년|천|백만|억)?$/);
          if (number) next = Number(number[1]) * ({ 천: 1e3, 백만: 1e6, 억: 1e8 }[number[2] as string] || 1);
        }
        if (key === 'stage') next = STAGES[next] || next.toLowerCase();
        if (key === 'buyer') next = resolveCountry(next) || next;
        if (key === 'currency') next = next.toUpperCase();
      }
      if (JSON.stringify(next) !== JSON.stringify(rawValue)) changes.push({ path: `${path}.${key}`, before: rawValue, after: next });
      result[key] = next;
    }
    return result;
  };
  const normalized = normalize(raw, 'record');
  normalized.country = country; normalized.system = system;
  const rec = { ...base, ...normalized, id: base.id, country, system };
  for (const field of ['plan', 'awarded', 'analysis']) if (normalized[field] && base[field]) rec[field] = { ...base[field], ...normalized[field] };
  const replaceFields = z.array(z.enum(['batches', 'projects', 'signals', 'mro'])).parse(input.replaceFields || []);
  for (const field of ARRAY_FIELDS) {
    if (!Array.isArray(normalized[field])) continue;
    const previous = base[field] || [];
    const keyOf = (x: any) => field === 'projects' ? x.id : field === 'batches' ? `${x.model.trim().toLowerCase()}@${x.introYear}` : `${x.year}@${x.text}`;
    const entries = new Map(previous.map((x: any) => [keyOf(x), x]));
    const incoming = new Map<string, any>();
    for (const item of normalized[field]) {
      const key = keyOf(item);
      if (incoming.has(key) && JSON.stringify(incoming.get(key)) !== JSON.stringify(item)) conflicts.push({ path: `${field}.${key}`, previous: incoming.get(key), incoming: item });
      incoming.set(key, item);
      if (!replaceFields.includes(field as any) && entries.has(key) && JSON.stringify(entries.get(key)) !== JSON.stringify(item)) conflicts.push({ path: `${field}.${key}`, previous: entries.get(key), incoming: item });
    }
    rec[field] = replaceFields.includes(field as any) ? [...incoming.values()] : [...new Map([...entries, ...incoming]).values()];
  }
  rec.src = [...new Set([...(base.src || []), ...(normalized.src || [])])];
  for (const field of z.array(z.enum(['awarded', 'plan', 'mro', 'signals', 'ratio', 'ratioEst', 'analysis'])).parse(input.removeFields || [])) delete rec[field];
  if (raw.id && raw.id !== base.id) changes.push({ path: 'record.id', before: raw.id, after: base.id });
  changes.push({ path: 'record.country', before: raw.country, after: country }, { path: 'record.system', before: raw.system, after: system });
  const candidate = { record: rec, expectedVersion: row?.version || 0, sources: input.sources || {}, evidence: input.evidence || [], reason: input.reason, asOf: input.asOf, rulesVersion: 'normalization-v1' as const, ...(input.countryMeta ? { countryMeta: input.countryMeta } : {}) };
  const parsed = submissionSchema.safeParse(candidate);
  const result = { ok: conflicts.length === 0 && parsed.success, rulesVersion: 'normalization-v1', payload: parsed.success && !conflicts.length ? parsed.data : null, candidate, changes, conflicts, errors: parsed.success ? [] : parsed.error.issues, semanticReviewRequired: true, warnings: ['원문이 주장을 입증하는지 검토하세요. 금액의 통화 환산은 자동 수행하지 않습니다.'] };
  const artifact = await ctx.repo.artifact(ctx.conversationId, `analysis/normalization-${randomUUID()}.json`, JSON.stringify({ original, ...result }, null, 2), { runId: ctx.runId, kind: 'normalization', mime: 'application/json' });
  return { ...result, auditPath: artifact.name, knownCountries: Object.keys(data.countries).length };
}
