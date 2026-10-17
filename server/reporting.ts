import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { execution } from './execution';
import { PROJECT_ROOT, hash, now } from './store';
import { resolveCountry, resolveSystem } from '../shared/data';
import { computeForecast } from '../shared/forecast';
import { writeReport } from '../shared/tools';
import type { ToolDef } from './agent';

const S = (description: string) => ({ type: 'string' as const, description });
export const REPORT_DEFS: ToolDef[] = [
  { name: 'get_report_template', description: '기본 워드와 파워포인트 양식 정의, 버전 및 검수 기준을 조회한다', properties: { templateId: S('생략하면 전체 양식'), format: S('docx 또는 pptx') } },
  { name: 'prepare_report', description: '요청 대상과 데이터, 예측 및 양식 버전을 고정한 문서 작성 자료를 보존한다', properties: { country: S('국가명. 생략하면 요청 당시 활성 화면의 국가'), system: S('무기체계. 전체는 general'), templateId: S('기본 word-country-v1'), purpose: S('독자와 작성 목적'), basis: S('latest 또는 viewed. 생략하면 열린 보고서 기준') } },
];
export function reportTemplates() { return JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates/report-templates-v1.json'), 'utf8')); }
export async function reportTool(name: string, a: Record<string, any>): Promise<unknown> {
  const ctx = await execution(), definitions = reportTemplates();
  if (name === 'get_report_template') {
    const templates = definitions.templates.filter((t: any) => (!a.templateId || t.id === a.templateId) && (!a.format || t.format === a.format));
    if (!templates.length) throw new Error('요청한 보고서 양식이 없습니다');
    return { ...definitions, templates };
  }
  const template = definitions.templates.find((t: any) => t.id === (a.templateId || 'word-country-v1'));
  if (!template) throw new Error('보고서 양식 확인 필요');
  const basis = z.enum(['latest', 'viewed']).parse(a.basis || (ctx.appContext?.activeView === 'report' && !a.country && !a.system ? 'viewed' : 'latest'));
  const state = ctx.appContext;
  const contextCountry = state?.activeView === 'report' ? state.report?.country : state?.focus;
  const country = resolveCountry(a.country || contextCountry);
  const contextSystem = state?.activeView === 'report' ? state.report?.system : state?.mode;
  const system = a.system ? (a.system === 'general' ? null : resolveSystem(a.system)) : contextSystem;
  if (!country || (a.system && a.system !== 'general' && !system)) throw new Error('보고서 대상 국가와 무기체계를 지정하세요');
  const snapshot = await ctx.repo.versionedData();
  const id = randomUUID(), createdAt = now();
  let packet: Record<string, unknown>;
  if (basis === 'viewed') {
    if (!state?.report) throw new Error('열어 둔 보고서가 없습니다');
    const report = await ctx.repo.one('SELECT * FROM reports WHERE id=? AND conversation_id=?', state.report.id, ctx.conversationId);
    if (!report || report.data_version !== state.report.dataVersion || country !== state.report.country || (system || null) !== state.report.system) throw new Error('열린 보고서와 작성 대상이 다릅니다');
    packet = { basis, country, system, revision: report.data_version, basisDate: report.basis_date, reportId: report.id, markdown: report.markdown, note: '보존 보고서의 내용이다. 현재 데이터와 혼합하지 않는다. 새 계산은 latest로 별도 준비한다.' };
  } else {
    const records = snapshot.data.records.filter(r => r.country === country && (!system || r.system === system));
    if (!records.length) throw new Error('대상 국가와 체계의 자료가 없습니다');
    const sourceIds = new Set(records.flatMap(r => [...r.src, ...r.batches.flatMap(b => b.src), ...(r.awarded?.src || []), ...(r.plan?.src || []), ...(r.mro || []).flatMap(m => m.src), ...(r.signals || []).flatMap(s => s.src), ...(r.projects || []).flatMap(p => p.src), ...snapshot.data.systems[r.system].costSrc]));
    packet = { basis, country, system: system || null, revision: snapshot.revision, basisDate: snapshot.data.meta.collected, records, forecasts: records.map(r => computeForecast(r, snapshot.data)), assumptions: snapshot.data.systems, meta: snapshot.data.meta, sources: Object.fromEntries(Object.entries(snapshot.data.sources).filter(([id]) => sourceIds.has(id))), analysis: writeReport({ country, system: system || undefined }, snapshot.data) };
  }
  packet = { ...packet, id, createdAt, purpose: a.purpose || '', requestContext: state || null, rulesVersion: 'normalization-v1', templateVersion: definitions.version, template, checks: definitions.checks, authoring: definitions.authoring };
  const content = JSON.stringify(packet, null, 2);
  const file = await ctx.repo.artifact(ctx.conversationId, `reports/prepared/${id}.json`, content, { runId: ctx.runId, kind: 'report-packet', mime: 'application/json' });
  await ctx.repo.event(ctx.runId, 'report.prepared', { id, path: file.name, hash: hash(content), templateId: template.id, revision: packet.revision });
  return { ...packet, filePath: file.name, hash: file.hash, nextStep: '기존 문서 작성 도구로 작성하고 렌더링 검수 후 publish_artifact에 preparationId와 검수 결과를 전달하세요' };
}
