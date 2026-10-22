import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { resolveCountry, resolveSystem } from '../shared/data';
import { execution } from './execution';
import { submissionSchema, submitResearch, supplierId } from './research';
import type { ToolDef } from './agent';
import { catalogCountry, catalogMetadata } from '../shared/countries';

const S = (description: string) => ({ type: 'string' as const, description });
export const NORMALIZATION_DEFS: ToolDef[] = [
  { name: 'normalize_procurement_data', description: '기존 조달 기록과 새 자료를 정제·병합한다. 저장하지 않는다. 실패하면 errors와 repair의 실제 출처 메타데이터·양식으로 고쳐 재호출한다', properties: { payload: S('JSON: record{country,system,batches:[{model,introYear:number|null,qty:number|null,est:string[],src:string[]}]}, expectedVersion?, sources:{출처ID:Source객체}(배열 아님), evidence:[{path:"batches",sourceId:"출처ID",quote:"원문 인용"}], reason, asOf(조사 기준일). Source는 t,u,y,publishedAt,collectedAt,filePath,hash,kind. est는 boolean이 아닌 추정 필드 이름 배열. evidence.path는 파일 경로가 아닌 변경 필드. replaceFields?, removeFields?, signalRows?') }, required: ['payload'] },
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
    if (typeof value === 'string' && /^record\.(batches\.\d+\.(qty|introYear)|awarded\.qty|plan\.qty)$/.test(path) && /^(?:미확인|비공개|미공개|알 수 없음|unknown|undisclosed|not disclosed|n\/?a|0{2,}|x{2,})(?:문|대|척|기|발|개|년)?$/i.test(value.trim())) {
      changes.push({ path, before: value, after: null }); return null;
    }
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
  const SIGNAL_STAGES: Record<string, string> = { 검토: 'review', 입찰: 'tender', 선정: 'selection', '선정 대기': 'selection', 계약: 'contract', 인도: 'delivery', 취소: 'cancelled' };
  const signalRows = Array.isArray(input.signalRows) ? input.signalRows.map((r: any, i: number) => {
    const next = { ...r };
    if (typeof next.stage === 'string') { const stage = SIGNAL_STAGES[next.stage.trim()] || next.stage.trim().toLowerCase(); if (stage !== r.stage) changes.push({ path: `signalRows.${i}.stage`, before: r.stage, after: stage }); next.stage = stage; }
    for (const key of ['quantity', 'expected_year', 'value_usd_m']) if (typeof next[key] === 'string') { const n = Number(next[key].replaceAll(',', '').replace(/(대|문|척|기|년)$/, '')); if (Number.isFinite(n)) { changes.push({ path: `signalRows.${i}.${key}`, before: next[key], after: n }); next[key] = n; } }
    if (typeof next.supplier === 'string') next.supplier = supplierId(next.supplier);
    return next;
  }) : undefined;
  const catalog = catalogCountry(country);
  const countryMeta = input.countryMeta || (!data.countries[country] && catalog ? catalogMetadata(catalog) : undefined);
  const candidate = { record: rec, ...(signalRows ? { signalRows } : {}), expectedVersion: row?.version || 0, sources: input.sources || {}, evidence: input.evidence || [], reason: input.reason, asOf: input.asOf, rulesVersion: 'normalization-v1' as const, ...(countryMeta ? { countryMeta } : {}) };
  const parsed = submissionSchema.safeParse(candidate);
  let repair: Record<string, unknown> | undefined;
  if (!parsed.success) {
    const originals = await ctx.repo.all("SELECT name,url,published_at,collected_at,hash FROM artifacts WHERE conversation_id=? AND kind IN ('original','attachment','extracted') AND status='ok' ORDER BY rowid DESC LIMIT 5", ctx.conversationId);
    const sourceCandidates = originals.filter(s => s.url).map(s => ({ sourceId: `source-${s.hash.slice(0, 16)}`, source: { t: s.url, u: s.url, y: s.published_at ? Number(s.published_at.slice(0, 4)) : 0, publishedAt: s.published_at || null, collectedAt: s.collected_at, filePath: s.name, hash: s.hash, kind: 'original' } }));
    const first = sourceCandidates[0], id = first?.sourceId || '원문출처ID';
    repair = {
      instructions: 'errors의 path를 수정하고 같은 요청에서 다시 normalize_procurement_data→validate_research→apply_research로 진행하세요. 사용자에게 양식 수정 허락을 다시 묻지 마세요. sources는 ID→객체 사전, est는 필드명 배열, src는 출처ID 배열이며 evidence.path는 batches 같은 변경 필드입니다. sourceCandidates는 실제 저장된 원문의 메타데이터입니다. 내용을 read_source로 확인한 출처만 사용하세요.',
      sourceCandidates,
      example: { record: { country, system, batches: [{ model: '원문에서 확인한 장비명으로 교체', introYear: null, qty: null, est: [], src: [id] }], src: [id] }, expectedVersion: row?.version || 0,
        sources: first ? { [id]: first.source } : {}, evidence: [{ path: 'batches', sourceId: id, quote: '보존 원문에 있는 정확한 인용문으로 교체' }], reason: '실제 변경 이유로 교체', asOf: new Date().toISOString().slice(0, 10) },
    };
  }
  const result = { ok: conflicts.length === 0 && parsed.success, rulesVersion: 'normalization-v1', payload: parsed.success && !conflicts.length ? parsed.data : null, candidate, changes, conflicts, errors: parsed.success ? [] : parsed.error.issues, ...(repair ? { repair } : {}), semanticReviewRequired: true, warnings: ['원문이 주장을 입증하는지 검토하세요. 금액의 통화 환산은 자동 수행하지 않습니다.'] };
  const artifact = await ctx.repo.artifact(ctx.conversationId, `analysis/normalization-${randomUUID()}.json`, JSON.stringify({ original, ...result }, null, 2), { runId: ctx.runId, kind: 'normalization', mime: 'application/json' });
  return { ...result, auditPath: artifact.name, knownCountries: Object.keys(data.countries).length };
}
