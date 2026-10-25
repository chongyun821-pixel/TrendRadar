import { seed, resolveCountry, resolveSystem, recordsBy, isGeneral } from './data';
import { computeForecast, allForecasts, CATEGORY_KO, fmtKrwRange, fmtQtyRange, formatKrw, isCurrentBatch, lifeSourced, PROJECT_STAGE_KO, needMet } from './forecast';
import { baseYearOf } from './base-year';
import { countryName } from './country-name';
import { koreanizeHanwha } from './hanwha';
import type { Forecast, SystemKey, Batch, Seed, ExportTierRow, ExportControlRow, NeighborRow, BudgetRow, SignalRow, ConsumptionRow, CapacityRow, DomesticRow, InventoryRow, SystemLinkRow, PairEventRow } from './types';

/** Shared Korean writing rule for research and report prompts. */
export const REPORT_WRITING_RULE = '보고서와 사용자에게 보이는 한국어 문장은 보고서체 "~다"로 자연스럽게 쓴다. 단어와 구절은 쉼표나 "와/과"로 잇는다. "나라" 대신 "국가"를 쓴다. 콜론을 겹쳐 쓰지 않는다.';

export interface ReportData {
  exportTiers?: ExportTierRow[]; exportControls?: ExportControlRow[]; neighbors?: NeighborRow[]; budgets?: BudgetRow[];
  signals?: SignalRow[]; consumption?: ConsumptionRow[]; capacity?: CapacityRow[]; domestic?: DomesticRow[];
  inventory?: InventoryRow[]; links?: SystemLinkRow[]; pairEvents?: PairEventRow[];
}

const est = (b: { est?: string[] }, f: string) => (b.est?.includes(f) ? ' (추정)' : '');
const srcList = (ids: string[]) => ids.map(id => seed.sources[id]).filter(Boolean).map(s => ({ title: s.t, url: s.u }));
const cName = (iso: string, data: Seed = seed) => countryName(iso, data);
const sName = (s: SystemKey) => seed.systems[s]?.ko ?? s;

function args(a: Record<string, unknown> | undefined) {
  const country = resolveCountry(a?.country as string);
  const system = resolveSystem(a?.system as string);
  if (a?.country && !country) throw new Error('알 수 없는 국가 필터입니다');
  if (a?.system && !system && !isGeneral(a.system as string)) throw new Error('알 수 없는 무기체계 필터입니다');
  return { country, system };
}

export function searchPrograms(a?: { country?: string; system?: string }) {
  const { country, system } = args(a);
  return recordsBy(country, system).map(r => ({
    country: cName(r.country), system: sName(r.system),
    inService: r.batches.filter(b => isCurrentBatch(b)).map(b => `${b.model} ${b.qty == null ? '수량 미확인' : `${b.qty}${seed.systems[r.system].unit}`}${est(b, 'qty')}, 도입 ${b.introYear ?? '미확인'}${est(b, 'introYear')}${b.covered ? ', 교체 계약분' : ''}`),
    contract: r.awarded ? { year: r.awarded.year, text: r.awarded.text, estimate: !!r.awarded.est?.length } : null,
    plan: r.plan ? { text: r.plan.text, window: `${r.plan.start}~${r.plan.end}` } : null,
    programs: (r.projects ?? []).map(p => ({ id: p.id, stage: PROJECT_STAGE_KO[p.stage], supplier: p.supplier ? (/^[A-Z]{3}$/.test(p.supplier) ? cName(p.supplier) : koreanizeHanwha(p.supplier)) : null, model: p.model ?? null, qty: p.qty ?? null, contractYear: p.contractYear ?? null, delivery: p.deliveryStart || p.deliveryEnd ? `${p.deliveryStart ?? '?'}~${p.deliveryEnd ?? '?'}` : null, reserve: p.reserve ? (/^[A-Z]{3}$/.test(p.reserve) ? cName(p.reserve) : koreanizeHanwha(p.reserve)) : null, estimate: p.est ?? [], text: p.text })),
    program: computeForecast(r).program?.reason ?? null,
    signals: (r.signals ?? []).map(s => `${s.year} ${s.text}`),
    sources: srcList(r.src),
  }));
}

export function getLifespan(a?: { system?: string; model?: string }) {
  const system = resolveSystem(a?.system);
  if (a?.system && !system) throw new Error('알 수 없는 무기체계 필터입니다');
  const model = (a?.model ?? '').toLowerCase();
  const systems = (system ? [system] : (Object.keys(seed.systems) as SystemKey[])).map(k => {
    const sourced = lifeSourced(seed.systems[k], seed);
    return { system: sName(k), designLife: seed.systems[k].designLife, estimate: !sourced, ...(sourced ? { sources: srcList(seed.systems[k].lifeSrc!) } : {}), note: sourced ? '출처가 있는 설계 수명. 배치별 MRO 연장은 별도 반영' : '체계별 기본 설계 수명(추정, 출처 없음). 배치별 MRO 연장은 별도 반영' };
  });
  const models = model ? seed.records.flatMap(r => r.batches.filter(b => (!system || r.system === system) && b.model.toLowerCase().includes(model)).map(b => ({
    country: cName(r.country), model: b.model, introYear: b.introYear, lifeExt: b.lifeExt ?? 0,
    replacementYear: b.introYear == null ? null : b.introYear + seed.systems[r.system].designLife + (b.lifeExt ?? 0), estimate: !!b.est?.length || !lifeSourced(seed.systems[r.system], seed),
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
    items: r.batches.filter(b => isCurrentBatch(b)).map((b: Batch) => ({ model: b.model, qty: b.qty, introYear: b.introYear, status: b.status || 'in_service', primary: !!b.primary, unit: seed.systems[r.system].unit, estimate: b.est ?? [], note: b.note })),
  }));
}

export function forecastBrief(f: Forecast) {
  return {
    country: f.countryKo, system: f.systemKo, status: f.status,
    window: f.window ? `${f.window[0]}~${f.window[1]}` : null, remainingYears: f.remaining, imminence: CATEGORY_KO[f.category], score: f.score,
    qty: fmtQtyRange(f.qty, f.unit), krw: fmtKrwRange(f.krw), confidence: f.confidence, label: '예측',
    ...(f.program ? { program: f.program.reason, opportunity: f.program.open ? '사업 기회(공급자 미정)' : needMet(f) ? '교체 수요 충족(진행 사업), 후속 주기만 남음' : f.program.covers < 1 ? '진행 사업이 일부만 대체' : '진행 사업이 교체 계산에 반영되지 않음(calc 참고)' } : {}),
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
  return allForecasts(system).sort((x, y) => y.score - x.score || (y.krw?.[1] ?? 0) - (x.krw?.[1] ?? 0)).slice(0, a?.limit ?? 20).map(forecastBrief);
}

const STATUS_KO: Record<Forecast['status'], string> = { open: '교체 수요(미계약)', plan: '공개 사업 계획', next: '현 사업 계약 완료, 후속 주기', none: '확인 가능한 자료가 부족하다.' };

export function writeReport(a?: { country?: string; system?: string }, data: Seed = seed, reportData: ReportData = {}): { markdown: string; country?: string; system?: SystemKey } | { error: string } {
  const baseYear = baseYearOf(data);
  const { country, system } = args(a);
  if (!country) return { error: '국가를 찾지 못함' };
  // 알 수 없는 체계 이름을 전체 체계 보고서로 바꾸지 않는다(일반, 생략만 전체)
  if (a?.system && !system && !isGeneral(a.system)) return { error: '무기체계를 찾지 못함' };
  const displayCountry = cName(country, data);
  const sysList: SystemKey[] = system ? [system] : data.records.filter(r => r.country === country).map(r => r.system);
    if (!sysList.length) return { error: `${displayCountry}의 자료를 확인하지 못함` };
  const parts: string[] = [];
  for (const s of sysList) {
    const r = data.records.find(r => r.country === country && r.system === s);
    if (!r) { parts.push(`## ${displayCountry} ${data.systems[s].ko}\n해당 체계의 자료를 확인하지 못했다.`); continue; }
    const f = computeForecast(r, data);
    const sys = data.systems[s];
    const L: string[] = [];
    L.push(`## ${f.flag} ${f.countryKo} ${f.systemKo} 보고서`);
    L.push(`### 1. 요약`);
    L.push(`- **구분** ${f.status === 'next' && f.program && !f.program.open ? `진행 중인 사업(${f.program.stageKo})에 따른 후속 주기` : STATUS_KO[f.status]}`);
    if (f.program) L.push(`- **사업 현황** ${f.program.reason}`);
    if (f.window) L.push(`- **예상 시기** ${f.window[0]}~${f.window[1]}년, 임박도 ${CATEGORY_KO[f.category]}, 점수 ${f.score}`);
    if (f.status !== 'none') L.push(`- **예상 규모** ${fmtQtyRange(f.qty, f.unit)}, ${fmtKrwRange(f.krw)}${f.krwEst ? ' (추정 포함)' : ''}`);
    L.push(`- **신뢰도** ${f.confidence}, 근거 ${f.nSources}건, 추정 항목 ${f.estCount}개`);
    L.push(`- **자료 기준** ${data.meta.collected || '기준일 미확인'}`);
    L.push(`### 2. 현재 보유와 도입 이력`);
    if (r.batches.length) for (const b of r.batches) L.push(`- ${b.model}: ${b.qty == null ? '수량 미확인' : `${b.qty}${sys.unit}`}${est(b, 'qty')}, 도입 ${b.introYear ?? '미확인'}${est(b, 'introYear')}${b.status === 'retired' ? ' — 퇴역' : b.status === 'planned' ? ' — 도입 예정' : ''}${b.covered ? ' — 교체 계약분' : ''}${b.note ? ` — ${b.note}` : ''}`);
    else L.push(`- 현재 보유 장비 자료를 확인하지 못했다. 사업 설명만으로 장비가 없다고 단정하지 않는다.`);
    if (r.awarded) L.push(`- **최근 계약** ${r.awarded.year}${est(r.awarded, 'year')} ${r.awarded.text}`);
    if (r.plan) L.push(`- **사업 계획** ${r.plan.text}`);
    for (const sg of r.signals ?? []) L.push(`- **동향** ${sg.year} ${sg.text}`);
    L.push(`### 3. 수명과 MRO`);
    L.push(`- **설계 수명** ${sys.designLife}년 (${f.lifeEst ? '체계 기본값을 적용한 추정치' : `근거 자료 ${(sys.lifeSrc || []).map(id => data.sources[id]?.t).filter(Boolean).join(', ')}`})`);
    if (r.mro?.length) for (const m of r.mro) L.push(`- ${m.year}${est(m, 'year')} ${m.text}${m.lifeExt ? ` → 수명 +${m.lifeExt}년${est(m, 'lifeExt')}` : ''}`);
    else L.push(`- 확인된 MRO 기록이 없다.`);
    L.push(`### 4. 예측 근거와 계산`);
    for (const c of f.calc) L.push(`- ${c}`);
    L.push(`- 기준 연도는 ${baseYear}년이며, 남은 기간은 시작 연도에서 기준 연도를 뺀 값이다. 동향 언급만으로 계약 수량이나 일정을 변경하지 않는다.`);
    if (r.analysis) {
      const labels: Record<string, string> = { facts: '확인 사실', estimates: '추정', conflicts: '상충과 선택 근거', unknowns: '미확인' };
      for (const [label, items] of Object.entries(r.analysis)) if (Array.isArray(items)) for (const item of items) L.push(`- **${labels[label] || label}** ${item}`);
    }
    L.push(`### 5. 경쟁 구도와 한화 기회`);
    if (r.awarded) L.push(`- **기존 계약** ${r.awarded.text}`);
    if (r.plan) L.push(`- **경쟁 현황** ${r.plan.text}`);
    L.push(`- **한화 제품** ${sys.hanwha.join(', ')}`);
    for (const p of r.projects ?? []) L.push(`- **${p.id}** 구매국 ${cName(p.buyer, data)}, 공급자 ${p.supplier ? cName(p.supplier, data) : '미정'}${p.reserve ? `, 예비 공급자 ${cName(p.reserve, data)}` : ''}, 단계 ${PROJECT_STAGE_KO[p.stage] ?? p.stage}, ${p.text}`);
    if (r.analysis?.opportunity) L.push(`- **조사 분석** ${r.analysis.opportunity}`);
    L.push(needMet(f) ? `- 공급자 ${f.program!.stage === 'selected' ? '선정' : '계약'} 완료로 기존 전력 교체 수요 충족, 신규 교체 사업 기회 아님. 후속 주기 ${f.window ? `${f.window[0]}~${f.window[1]}년(추정)` : '미확인'}, MRO, 현지화, 후속 물량만 기회${f.program!.reserve ? ` (예비 공급자는 ${f.program!.reserve}, 협상 결렬 시 기회)` : ''}`
      : f.program?.open ? `- 공급자 미정(${f.program.stageKo}), 사업 기회 유지, 교체 시기보다 1~3년 앞선 시점이 제안 적기`
      : f.status === 'next' ? `- 현 사업 계약 완료, 후속 물량과 추가 물량, MRO 및 현지화 협력 기회` : f.status === 'none' ? `- 자료 보강 필요` : `- 교체 시기보다 1~3년 앞선 시점이 제안 적기`);
    L.push(`### 6. 출처`);
    for (const so of f.sources) L.push(`- [${so.t}](${so.u})`);
    for (const id of sys.costSrc) { const so = data.sources[id]; if (so && !f.sources.includes(so)) L.push(`- [${so.t}](${so.u}) (단가)`); }
    for (const id of sys.lifeSrc || []) { const so = data.sources[id]; if (so && !f.sources.includes(so)) L.push(`- [${so.t}](${so.u}) (수명)`); }
    L.push(`\n_예측은 공개 자료를 바탕으로 산출한 범위 추정치이며 확정 정보가 아니다. "추정" 표기 값은 직접 확인할 출처가 없는 항목이다._`);

    const tier = reportData.exportTiers?.find(row => row.country === country && row.system === s)
      ?? reportData.exportTiers?.find(row => row.country === country && row.system === '*');
    const controls = reportData.exportControls?.filter(row => row.country === country) ?? [];
    if (tier || controls.length) {
      L.push('### 7. 수출 가능 여부와 사유');
      if (tier) {
        const label = tier.tier === 1 ? '수출 가능' : tier.tier === 2 ? '조건부 수출 가능' : '수출 불가';
        L.push(`- ${label}, 확인일 ${tier.tier_checked_at}`);
        for (const reason of tier.tier_reasons?.reasons ?? []) L.push(`- ${reason.text}`);
        for (const approval of tier.tier_reasons?.approvals ?? []) L.push(`- 추가 확인 ${approval}`);
      }
      for (const control of controls) L.push(`- ${control.regime} ${control.name}, 상태 ${control.status}${control.started ? `, 시작 ${control.started}` : ''}${control.ended ? `, 종료 ${control.ended}` : ''}`);
    }

    const budgets = (reportData.budgets ?? []).filter(row => row.country === country).sort((x, y) => y.year - x.year).slice(0, 4).reverse();
    if (budgets.length) {
      L.push('### 8. 국방 예산과 군사비 추세');
      const usdKrw = Number(data.meta.fx.USD ?? data.meta.fx.usd);
      for (const budget of budgets) {
        const amount = budget.usd_m != null && Number.isFinite(usdKrw) && usdKrw > 0 ? `, 원화 환산 ${formatKrw(budget.usd_m * usdKrw / 100)}` : '';
        L.push(`- ${budget.year}년 군사비${amount}${budget.gdp_pct != null ? `, GDP 대비 ${budget.gdp_pct}%` : ''}${budget.yoy_pct != null ? `, 전년 대비 ${budget.yoy_pct}%` : ''}`);
      }
    }

    const neighbors = (reportData.neighbors ?? []).filter(row => row.country === country);
    const neighborIds = new Set(neighbors.map(row => row.neighbor));
    const events = reportData.pairEvents?.filter(row => (row.country === country && neighborIds.has(row.counterpart)) || (neighborIds.has(row.country) && row.counterpart === country)) ?? [];
    if (neighbors.length || events.length) {
      L.push('### 9. 인접국 긴장도와 최근 사건');
      for (const neighbor of neighbors) L.push(`- ${cName(neighbor.neighbor, data)}${neighbor.kind === 'land' ? ' 육상 인접' : neighbor.kind === 'sea' ? ' 해상 인접' : ' 경쟁 관계'}${neighbor.tension != null ? `, 긴장도 ${neighbor.tension.toFixed(2)}` : ''}${neighbor.computed_at ? `, 산출 ${neighbor.computed_at.slice(0, 10)}` : ''}`);
      for (const event of [...events].sort((x, y) => y.period.localeCompare(x.period)).slice(0, 5)) L.push(`- ${event.period}, ${cName(event.counterpart, data)} 관련 사건 ${event.events ?? '미확인'}건, 사망 ${event.fatalities ?? '미확인'}명`);
    }

    const signals = (reportData.signals ?? []).filter(row => row.country === country && row.system === s);
    const projects = r.projects ?? [];
    if (signals.length || projects.length) {
      L.push('### 10. 조달 신호와 진행 사업 단계');
      const signalStages = { consideration: '검토', tender: '입찰', selected: '공급자 선정', contract: '계약', delivery: '인도', cancelled: '취소' };
      for (const signal of signals) L.push(`- ${signal.expected_year ?? signal.published_at?.slice(0, 4) ?? '연도 미상'} ${signalStages[signal.stage]}${signal.model ? `, ${signal.model}` : ''}${signal.supplier || signal.maker ? `, 공급 ${cName(signal.supplier ?? signal.maker!, data)}` : ''}${signal.quantity != null ? `, ${signal.quantity}${sys.unit}` : ''}${signal.note ? `, ${signal.note}` : ''}`);
      for (const project of projects) L.push(`- ${project.id}, ${PROJECT_STAGE_KO[project.stage] ?? project.stage}${project.supplier ? `, 공급사 ${cName(project.supplier, data)}` : ''}${project.deliveryStart || project.deliveryEnd ? `, 인도 ${project.deliveryStart ?? '?'}~${project.deliveryEnd ?? '?'}` : ''}, ${project.text}`);
    }

    const domestic = reportData.domestic?.find(row => row.country === country && row.system === s);
    if (domestic) L.push(`### 11. 자체 생산 능력\n- ${domestic.status === 'production' ? '생산 중' : domestic.status === 'development' ? '개발 중' : '자체 생산 없음'}${domestic.program ? `, ${domestic.program}` : ''}`);

    const currentInventory = (reportData.inventory ?? []).filter(row => row.country === country && row.system === s);
    const consumption = (reportData.consumption ?? []).filter(row => (row.user_country === country || row.target_country === country) && row.system === s);
    if (currentInventory.length || consumption.length) {
      L.push('### 12. 보유 장비와 소모 추정');
      for (const item of currentInventory) L.push(`- ${item.model}, 수량 ${item.quantity ?? '미확인'}${item.delivered_year != null ? `, 인도 ${item.delivered_year}년` : ''}${item.retire_year != null ? `, 퇴역 예상 ${item.retire_year}년` : ''}${item.supplier ? `, 제조사 ${cName(item.supplier, data)}` : ''}`);
      for (const item of consumption) L.push(`- ${item.conflict} ${item.period ?? ''}, ${item.kind === 'loss' ? '손실' : item.kind === 'donation' ? '공여' : '소모'} ${item.quantity}${sys.unit}${item.model ? `, ${item.model}` : ''}`);
    }

    const manufacturers = [...new Set([
      ...(reportData.links ?? []).filter(row => row.system === s && !row.is_group && row.maker).map(row => row.maker!),
      ...currentInventory.map(row => row.supplier).filter((maker): maker is string => !!maker),
    ])];
    if (manufacturers.length) L.push(`### 13. 주요 장비 제조사\n- ${manufacturers.join(', ')}`);

    const models = new Set([...(r.batches ?? []).map(batch => batch.model), ...currentInventory.map(item => item.model)]);
    const makerSet = new Set(manufacturers);
    const capacity = (reportData.capacity ?? []).filter(row => makerSet.has(row.maker) && models.has(row.model)).sort((x, y) => y.year - x.year);
    if (capacity.length) {
      L.push('### 14. 공급사 생산 여력');
      for (const row of capacity.slice(0, 8)) L.push(`- ${row.maker} ${row.model}, ${row.year}년 생산 여력 ${row.annual_output ?? '미확인'}대, 수주 잔량 ${row.backlog ?? '미확인'}대`);
    }
    parts.push(L.join('\n'));
  }
  // Source text may contain punctuation that report prose normalizes.
  const markdown = parts.join('\n\n---\n\n').replace(/\u00b7/g, ', ');
  return { markdown, country, system: system ?? undefined };
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
