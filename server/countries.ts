import { z } from 'zod';
import { catalogCountry, catalogMetadata, countryKey, searchCountries } from '../shared/countries';
import { execution } from './execution';
import { now } from './store';
import type { ToolDef } from './agent';
import { countryCoverage } from '../shared/completeness';
import { resolveSystem } from '../shared/data';
import { saveEquipment } from './equipment';

const country = { type: 'string' as const, description: '국가의 한국어·영문 이름 또는 국가 코드. 예: 독일, Germany, DEU' };
export const COUNTRY_DEFS: ToolDef[] = [
  { name: 'find_country', description: '앱 지도 국가 목록에서 이름·코드를 찾고 등록 여부와 조사된 무기체계를 확인한다. 저장하지 않는다', properties: { country }, required: ['country'] },
  { name: 'add_country', description: '사용자가 추가를 요청한 국가를 운영 DB에 등록한다. 국가명·국기·지도 위치를 자동 설정하고 기존 국가는 보존한다. 조달 수치·예측은 별도 조사가 필요하다', properties: { country }, required: ['country'] },
  { name: 'get_country_data_status', description: '국가의 체계별 현재 주력·교체 시기·수량·원문 근거 충족 여부와 누락을 검사한다. 국가 추가·조사 완료를 답하기 전에 확인한다', properties: { country, system: { type: 'string', description: '무기체계. 생략하면 운영 DB에 있는 전체 체계' } }, required: ['country'] },
  { name: 'save_equipment', description: '확인된 장비 하나를 원문 근거와 함께 저장한다. 현재 주력·교체 시기 빈칸 보완에 우선 사용한다. 서버가 출처 메타데이터·정제·검증·예측을 처리한다. 미확인 수량·연도는 생략하며 검색 요약은 원문으로 사용할 수 없다', properties: {
    country, system: { type: 'string', description: '무기체계' }, model: { type: 'string', description: '원문으로 확인한 장비명' },
    filePath: { type: 'string', description: '현재 대화에 저장한 원문 텍스트 파일 경로' }, quote: { type: 'string', description: '해당 사실을 뒷받침하는 보존 원문의 정확한 인용문' },
    introYear: { type: 'integer', description: '확인된 도입·전력화 연도. 미확인은 생략' }, qty: { type: 'integer', description: '확인된 현재 보유 수량. 비공개·미확인은 생략' },
    primary: { type: 'boolean', description: '주력 장비임을 확인한 경우 true' }, status: { type: 'string', description: 'in_service(기본), retired, planned' },
    introYearEstimated: { type: 'boolean', description: '초도 도입 연도를 전체 배치의 참고 연도로 적용하는 추정이면 true' }, note: { type: 'string', description: '자료의 범위·배치 구분·불확실성' }, title: { type: 'string', description: '원문 제목' },
  }, required: ['country','system','model','filePath','quote'] },
];

export async function countryTool(name: string, args: Record<string, any>) {
  if (name === 'save_equipment') return saveEquipment(args);
  const input = z.string().trim().min(1).max(100).parse(args.country);
  const ctx = await execution(), repo = ctx.repo, data = await repo.data();
  const existing = Object.entries(data.countries).find(([id, meta]) => countryKey(id) === countryKey(input) || countryKey(meta.ko) === countryKey(input));
  const catalog = catalogCountry(input);
  const id = existing?.[0] || catalog?.id;
  const describe = (countryId: string, metadata: typeof data.countries[string]) => ({
    country: countryId, metadata, registered: !!data.countries[countryId],
    systems: data.records.filter(r => r.country === countryId).map(r => r.system),
    coverage: countryCoverage(data, countryId),
  });
  if (name === 'find_country') return {
    matches: id ? [describe(id, data.countries[id] || catalogMetadata(catalog!))]
      : searchCountries(input).slice(0, 10).map(c => describe(c.id, data.countries[c.id] || catalogMetadata(c))),
    note: '등록과 조달 조사는 별도입니다. 추가 요청은 add_country, 자료 조사는 research_procurement로 시작하세요.',
  };
  if (!id) throw new Error('지도 국가 목록에서 정확한 국가를 찾지 못했습니다. find_country로 후보를 확인하고 정확한 이름이나 코드를 사용하세요');
  if (name === 'get_country_data_status') {
    const system = args.system ? resolveSystem(args.system) : null;
    if (args.system && (!system || !data.systems[system])) throw new Error('현재 지원하는 무기체계를 지정하세요');
    const coverage = countryCoverage(data, id, system);
    return { country: id, registered: !!data.countries[id], complete: coverage.every(c => c.status === 'ready'), coverage,
      next: '빈 batches는 운용 장비·도입 연도부터 조사한다. 미공개 수량은 null로 보존하고 시기만 계산한다. 누락마다 접근 실패·미공개 등 이유를 보고하며 모든 체계 조사 완료로 표현하지 않는다.' };
  }
  return repo.transaction(async () => {
    await execution();
    const row = await repo.one('SELECT data FROM countries WHERE id=?', id);
    const metadata = row ? JSON.parse(row.data) : catalogMetadata(catalog!);
    const date = now();
    if (!row) {
      await repo.run('INSERT INTO countries(id,data) VALUES (?,?)', id, JSON.stringify(metadata));
      await repo.run('INSERT INTO changes(record_id,run_id,before_data,after_data,reason,evidence,created_at) VALUES(?,?,?,?,?,?,?)', `@country:${id}`, ctx.runId, null, JSON.stringify(metadata), '사용자 요청으로 국가 등록', JSON.stringify([{ path: `countries.${id}`, source: 'Natural Earth', file: 'data/ne_110m_admin_0_countries.geojson', featureId: id }]), date);
      await repo.run("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
      const meta = JSON.parse((await repo.one("SELECT value FROM metadata WHERE key='meta'")).value);
      await repo.run("UPDATE metadata SET value=? WHERE key='meta'", JSON.stringify({ ...meta, collected: date }));
    }
    const systems = (await repo.all('SELECT system FROM records WHERE country=?', id)).map(r => r.system);
    const coverage = countryCoverage(await repo.data(), id);
    return {
      ok: true, created: !row, country: id, metadata, registered: true, revision: await repo.revision(), systems,
      coverage, researchRequired: coverage.some(c => c.status !== 'ready'),
      note: row ? '이미 등록된 국가입니다. 기존 국가 정보와 조사 자료를 유지했습니다.' : '국가 등록을 완료했습니다. 조달 자료와 예측은 아직 추가되지 않았습니다.',
      next: '국가만 등록하라는 요청이 아니면 coverage에서 부족한 체계를 research_procurement → 원문 수집·보존 → normalize_procurement_data → validate_research → apply_research로 보완한다. 마지막에 get_country_data_status로 실제 지도 필드가 채워졌는지 확인한다.',
    };
  }, ctx.signal);
}
