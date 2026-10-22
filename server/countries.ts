import { z } from 'zod';
import { catalogCountry, catalogMetadata, countryKey, searchCountries } from '../shared/countries';
import { execution } from './execution';
import { now } from './store';
import type { ToolDef } from './agent';

const country = { type: 'string' as const, description: '국가의 한국어·영문 이름 또는 국가 코드. 예: 독일, Germany, DEU' };
export const COUNTRY_DEFS: ToolDef[] = [
  { name: 'find_country', description: '앱 지도 국가 목록에서 이름·코드를 찾고 등록 여부와 조사된 무기체계를 확인한다. 저장하지 않는다', properties: { country }, required: ['country'] },
  { name: 'add_country', description: '사용자가 추가를 요청한 국가를 운영 DB에 등록한다. 국가명·국기·지도 위치를 자동 설정하고 기존 국가는 보존한다. 조달 수치·예측은 별도 조사가 필요하다', properties: { country }, required: ['country'] },
];

export async function countryTool(name: string, args: Record<string, any>) {
  const input = z.string().trim().min(1).max(100).parse(args.country);
  const ctx = await execution(), repo = ctx.repo, data = await repo.data();
  const existing = Object.entries(data.countries).find(([id, meta]) => countryKey(id) === countryKey(input) || countryKey(meta.ko) === countryKey(input));
  const catalog = catalogCountry(input);
  const id = existing?.[0] || catalog?.id;
  const describe = (countryId: string, metadata: typeof data.countries[string]) => ({
    country: countryId, metadata, registered: !!data.countries[countryId],
    systems: data.records.filter(r => r.country === countryId).map(r => r.system),
  });
  if (name === 'find_country') return {
    matches: id ? [describe(id, data.countries[id] || catalogMetadata(catalog!))]
      : searchCountries(input).slice(0, 10).map(c => describe(c.id, data.countries[c.id] || catalogMetadata(c))),
    note: '등록과 조달 조사는 별도입니다. 추가 요청은 add_country, 자료 조사는 research_procurement로 시작하세요.',
  };
  if (!id) throw new Error('지도 국가 목록에서 정확한 국가를 찾지 못했습니다. find_country로 후보를 확인하고 정확한 이름이나 코드를 사용하세요');
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
    return {
      ok: true, created: !row, country: id, metadata, registered: true, revision: await repo.revision(), systems,
      researchRequired: systems.length === 0,
      note: row ? '이미 등록된 국가입니다. 기존 국가 정보와 조사 자료를 유지했습니다.' : '국가 등록을 완료했습니다. 조달 자료와 예측은 아직 추가되지 않았습니다.',
      next: '조사를 요청받았으면 research_procurement → 원문 수집·보존 → normalize_procurement_data → validate_research → apply_research로 해당 무기체계의 자료를 반영하세요.',
    };
  }, ctx.signal);
}
