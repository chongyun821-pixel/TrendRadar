import { seed, resolveCountry, resolveSystem, recordsBy } from './data';
import { computeForecast, allForecasts, CATEGORY_KO, fmtKrwRange } from './forecast';
import type { Forecast, SystemKey, Batch, Seed } from './types';

const est = (b: { est?: string[] }, f: string) => (b.est?.includes(f) ? ' (추정)' : '');
const srcList = (ids: string[]) => ids.map(id => seed.sources[id]).filter(Boolean).map(s => ({ title: s.t, url: s.u }));
const cName = (iso: string) => seed.countries[iso]?.ko ?? iso;
const sName = (s: SystemKey) => seed.systems[s]?.ko ?? s;

function args(a: Record<string, unknown> | undefined) {
  const country = resolveCountry(a?.country as string);
  const system = resolveSystem(a?.system as string);
  return { country, system };
}

export function searchPrograms(a?: { country?: string; system?: string }) {
  const { country, system } = args(a);
  return recordsBy(country, system).map(r => ({
    country: cName(r.country), system: sName(r.system),
    inService: r.batches.map(b => `${b.model} ${b.qty}${seed.systems[r.system].unit}${est(b, 'qty')}, 도입 ${b.introYear}${est(b, 'introYear')}${b.covered ? ', 교체 계약분' : ''}`),
    contract: r.awarded ? { year: r.awarded.year, text: r.awarded.text, estimate: !!r.awarded.est?.length } : null,
    plan: r.plan ? { text: r.plan.text, window: `${r.plan.start}~${r.plan.end}` } : null,
    signals: (r.signals ?? []).map(s => `${s.year} ${s.text}`),
    sources: srcList(r.src),
  }));
}

export function getLifespan(a?: { system?: string; model?: string }) {
  const system = resolveSystem(a?.system);
  const model = (a?.model ?? '').toLowerCase();
  const systems = (system ? [system] : (Object.keys(seed.systems) as SystemKey[])).map(k => ({
    system: sName(k), designLife: seed.systems[k].designLife, estimate: true, note: '체계별 기본 설계 수명(추정). 배치별 MRO 연장은 별도 반영',
  }));
  const models = model ? seed.records.flatMap(r => r.batches.filter(b => b.model.toLowerCase().includes(model)).map(b => ({
    country: cName(r.country), model: b.model, introYear: b.introYear, lifeExt: b.lifeExt ?? 0,
    replacementYear: b.introYear + seed.systems[r.system].designLife + (b.lifeExt ?? 0), estimate: !!b.est?.length,
  }))) : [];
  return { systems, models };
}

export function searchMro(a?: { country?: string; model?: string; system?: string }) {
  const { country, system } = args(a);
  const model = (a?.model ?? '').toLowerCase();
  return recordsBy(country, system).flatMap(r => (r.mro ?? []).map(m => ({ country: cName(r.country), system: sName(r.system), ...m })))
    .filter(m => !model || m.text.toLowerCase().includes(model) || recordsBy(resolveCountry(m.country), resolveSystem(m.system)).some(r => r.batches.some(b => b.model.toLowerCase().includes(model))))
    .map(m => ({ country: m.country, system: m.system, year: m.year, text: m.text, lifeExt: m.lifeExt, estimate: !!m.est?.length, sources: srcList(m.src) }));
}

export function getInventory(a?: { country?: string; system?: string }) {
  const { country, system } = args(a);
  return recordsBy(country, system).map(r => ({
    country: cName(r.country), system: sName(r.system),
    items: r.batches.map((b: Batch) => ({ model: b.model, qty: b.qty, introYear: b.introYear, unit: seed.systems[r.system].unit, estimate: b.est ?? [], note: b.note })),
  }));
}

export function forecastBrief(f: Forecast) {
  return {
    country: f.countryKo, system: f.systemKo, status: f.status,
    window: f.window ? `${f.window[0]}~${f.window[1]}` : null, remainingYears: f.remaining, imminence: CATEGORY_KO[f.category], score: f.score,
    qty: `${f.qty[0]}~${f.qty[1]}${f.unit}`, krw: fmtKrwRange(f.krw), confidence: f.confidence, label: '예측',
  };
}

export function forecast(a?: { country?: string; system?: string }) {
  const { country, system } = args(a);
  if (!country) return { error: '국가를 찾지 못함' };
  const recs = recordsBy(country, system);
  if (!recs.length) return { error: `${cName(country)}${system ? ' ' + sName(system) : ''} 데이터 없음` };
  return recs.map(r => { const f = computeForecast(r); return { ...forecastBrief(f), calc: f.calc }; });
}

export function listForecasts(a?: { system?: string; limit?: number }) {
  const system = resolveSystem(a?.system);
  return allForecasts(system).sort((x, y) => y.score - x.score || y.krw[1] - x.krw[1]).slice(0, a?.limit ?? 20).map(forecastBrief);
}

const STATUS_KO: Record<Forecast['status'], string> = { open: '교체 수요(미계약)', plan: '공개 사업 계획', next: '현 사업 계약 완료 → 후속 주기', none: '데이터 부족' };

export function writeReport(a?: { country?: string; system?: string }, data: Seed = seed): { markdown: string; country?: string; system?: SystemKey } | { error: string } {
  const baseYear = new Date().getFullYear();
  const { country, system } = args(a);
  if (!country) return { error: '국가를 찾지 못함' };
  const countryName = data.countries[country]?.ko ?? country;
  const sysList: SystemKey[] = system ? [system] : data.records.filter(r => r.country === country).map(r => r.system);
  if (!sysList.length) return { error: `${countryName} 데이터 없음` };
  const parts: string[] = [];
  for (const s of sysList) {
    const r = data.records.find(r => r.country === country && r.system === s);
    if (!r) { parts.push(`## ${countryName} · ${data.systems[s].ko}\n데이터 없음`); continue; }
    const f = computeForecast(r, data);
    const sys = data.systems[s];
    const L: string[] = [];
    L.push(`## ${f.flag} ${f.countryKo} · ${f.systemKo} 보고서`);
    L.push(`### 1. 요약`);
    L.push(`- 구분: ${STATUS_KO[f.status]}`);
    if (f.window) L.push(`- 예상 시기(예측): **${f.window[0]}~${f.window[1]}년** · 임박도 ${CATEGORY_KO[f.category]} (점수 ${f.score})`);
    if (f.status !== 'none') L.push(`- 예상 규모(예측): **${f.qty[0]}~${f.qty[1]}${f.unit}**, **${fmtKrwRange(f.krw)}**${f.krwEst ? ' (추정 포함)' : ''}`);
    L.push(`- 신뢰도: ${f.confidence} (근거 ${f.nSources}건, 추정 항목 ${f.estCount}개)`);
    L.push(`- 자료 기준: ${data.meta.collected || '미확인'}`);
    L.push(`### 2. 현재 보유와 도입 이력`);
    if (r.batches.length) for (const b of r.batches) L.push(`- ${b.model}: ${b.qty}${sys.unit}${est(b, 'qty')}, 도입 ${b.introYear}${est(b, 'introYear')}${b.covered ? ' — 교체 계약분' : ''}${b.note ? ` — ${b.note}` : ''}`);
    else L.push(`- 교체 대상 구형 장비 없음`);
    if (r.awarded) L.push(`- 최근 계약: ${r.awarded.year}${est(r.awarded, 'year')} ${r.awarded.text}`);
    if (r.plan) L.push(`- 사업 계획: ${r.plan.text}`);
    for (const sg of r.signals ?? []) L.push(`- 동향: ${sg.year} ${sg.text}`);
    L.push(`### 3. 수명·MRO`);
    L.push(`- 설계 수명: ${sys.designLife}년 (체계 기본값, 추정)`);
    if (r.mro?.length) for (const m of r.mro) L.push(`- ${m.year}${est(m, 'year')} ${m.text}${m.lifeExt ? ` → 수명 +${m.lifeExt}년${est(m, 'lifeExt')}` : ''}`);
    else L.push(`- 확인된 MRO 기록 없음`);
    L.push(`### 4. 예측 근거와 계산`);
    for (const c of f.calc) L.push(`- ${c}`);
    L.push(`- 기준 연도 ${baseYear}, 남은 기간 = 시작 연도 − ${baseYear}. 동향 언급만으로 계약 수량·일정을 변경하지 않음`);
    if (r.analysis) {
      const labels: Record<string, string> = { facts: '확인 사실', estimates: '추정', conflicts: '상충·선택 근거', unknowns: '미확인' };
      for (const [label, items] of Object.entries(r.analysis)) if (Array.isArray(items)) for (const item of items) L.push(`- ${labels[label] || label}: ${item}`);
    }
    L.push(`### 5. 경쟁 구도와 한화 기회`);
    if (r.awarded) L.push(`- 기존 계약: ${r.awarded.text}`);
    if (r.plan) L.push(`- 경쟁 현황: ${r.plan.text}`);
    L.push(`- 해당 한화 제품: ${sys.hanwha.join(', ')}`);
    for (const p of r.projects ?? []) L.push(`- ${p.id}: 구매국 ${p.buyer} · 공급자 ${p.supplier} · 단계 ${p.stage} · ${p.text}`);
    if (r.analysis?.opportunity) L.push(`- 조사 분석: ${r.analysis.opportunity}`);
    L.push(f.status === 'next' ? `- 현 사업은 계약 완료. 후속·추가 물량, MRO·현지화 협력이 기회` : f.status === 'none' ? `- 데이터 보강 필요` : `- 교체 창 전 1~3년이 제안 시점`);
    L.push(`### 6. 출처`);
    for (const so of f.sources) L.push(`- [${so.t}](${so.u})`);
    for (const id of sys.costSrc) { const so = data.sources[id]; if (so && !f.sources.includes(so)) L.push(`- [${so.t}](${so.u}) (단가)`); }
    L.push(`\n_예측은 공개 자료 기반 범위 추정이며 확정 정보가 아님. "추정" 표기 값은 출처 없음._`);
    parts.push(L.join('\n'));
  }
  return { markdown: parts.join('\n\n---\n\n'), country, system: system ?? undefined };
}

export const TOOL_IMPLS: Record<string, (a: any) => unknown> = {
  search_programs: searchPrograms,
  get_lifespan: getLifespan,
  search_mro: searchMro,
  get_inventory: getInventory,
  forecast,
  get_forecast: forecast,
  list_forecasts: listForecasts,
  write_report: writeReport,
};
