import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { repository } from '../server/store';
import { scoringInputs, selectRows } from '../server/collection';
import { computeScore } from '../shared/forecast';
import { countryId, parseArgs, parseCsv, type Fetch } from '../server/ingest/common';
import { classifyWeapon, dealValue, ingestSipriTransfers, plannedEnd, SIPRI_TRANSFERS_URL } from '../server/ingest/sipri-transfers';
import { ingestSipriMilex } from '../server/ingest/sipri-milex';
import { ingestSipriEmbargoes } from '../server/ingest/sipri-embargoes';
import { ingestItar } from '../server/ingest/itar';
import { ingestWorldBank } from '../server/ingest/worldbank';
import { ingestUcdp } from '../server/ingest/ucdp';
import { gdeltDayUrl, ingestGdelt, tallyDay } from '../server/ingest/gdelt';
import { ingestOryx } from '../server/ingest/oryx';
import { ingestTiers } from '../server/ingest/tiers';
import { ingestTension } from '../server/ingest/tension';

const fixture = (name: string) => join(import.meta.dirname, 'fixtures/ingest', name);
const NOW = '2026-10-21T00:00:00.000Z';
/** 주소별 가짜 응답. 등록되지 않은 주소는 실패시켜 실제 네트워크로 나가지 않게 한다 */
function mockFetch(routes: Record<string, (init?: RequestInit) => BodyInit | Response>, calls: string[] = []): Fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); calls.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return new Response('not mocked', { status: 404 });
    const body = hit[1](init);
    return body instanceof Response ? body : new Response(body);
  }) as Fetch;
}

/** 최소 XLSX(공유 문자열 + 숫자) 생성 */
function xlsx(sheets: Record<string, (string | number)[][]>): Uint8Array {
  const strings: string[] = [], si = (s: string) => { let i = strings.indexOf(s); if (i < 0) { strings.push(s); i = strings.length - 1; } return i; };
  const col = (i: number) => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const files: Record<string, Uint8Array> = {}, names = Object.keys(sheets);
  names.forEach((name, n) => {
    const rows = sheets[name].map((r, y) => `<row r="${y + 1}">${r.map((v, x) => typeof v === 'number' ? `<c r="${col(x)}${y + 1}"><v>${v}</v></c>` : `<c r="${col(x)}${y + 1}" t="s"><v>${si(v)}</v></c>`).join('')}</row>`).join('');
    files[`xl/worksheets/sheet${n + 1}.xml`] = strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`);
  });
  files['xl/workbook.xml'] = strToU8(`<workbook><sheets>${names.map((n, i) => `<sheet name="${n.replace(/&/g, '&amp;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(`<Relationships>${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`);
  files['xl/sharedStrings.xml'] = strToU8(`<sst>${strings.map(s => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`);
  return zipSync(files);
}
const milexBook = () => {
  const head = ['Country', 'Notes', 2021, 2022, 2023, 2024, 2025];
  const title = [['SIPRI Military Expenditure Database'], [], [], [], [], head];
  return xlsx({
    'Constant (2024) US$': [...title, ['Europe'], ['Poland', '', 15000, 17000, 25000, 33000, 40000], ['Korea, South', '', 46000, 46500, 47000, 47500, 48000], ['Ukraine', '', 5000, 40000, 'xxx', '...', '...']],
    'Current US$': [...title, ['Europe'], ['Poland', '', 14000, 16000, 26459.28, 34459.55, 46760.13], ['Korea, South', '', 50000, 46000, 47801.86, 47604.58, 47770.91], ['Ukraine', '', 5900, 44000, '...', '...', '...']],
    'Share of GDP': [...title, ['Europe'], ['Poland', '', 0.022, 0.024, 0.0326, 0.0375, 0.045], ['Korea, South', '', 0.026, 0.026, 0.026, 0.0254, 0.026]],
  });
};
const wb = (points: [string, string, number | null][]) => JSON.stringify([{ page: 1, pages: 1 }, points.map(([iso, date, value]) => ({ countryiso3code: iso, date, value, country: { value: iso } }))]);
const gdeltLine = (a1: string, a2: string, root: string, goldstein: number) => { const f = Array(58).fill(''); f[0] = '1'; f[1] = '20260915'; f[7] = a1; f[17] = a2; f[28] = root; f[30] = String(goldstein); return f.join('\t'); };

describe('수집 공통', () => {
  it('인자·CSV·국가명 매칭', () => {
    expect(parseArgs(['--dry-run', '--year', '2025', '--file=/x.csv'])).toEqual({ 'dry-run': true, year: '2025', file: '/x.csv' });
    expect(parseCsv('a,"b,""c"""\n1,2\r\n')).toEqual([['a', 'b,"c"'], ['1', '2']]);
    expect(['South Korea', 'Korea, South', 'Russia (Soviet Union)', 'Türkiye', 'Viet Nam', 'Singapore', '폴란드', 'NOR', 'Houthi rebels (Yemen)*', 'NATO**', 'Atlantis'].map(countryId))
      .toEqual(['KOR', 'KOR', 'RUS', 'TUR', 'VNM', 'SGP', 'POL', 'NOR', null, null, null]);
  });
  it('SIPRI 무기 설명 분류와 비고 해석', () => {
    expect(['self-propelled gun', 'infantry fighting vehicle', 'multiple rocket launcher', 'mobile surface-to-air missile system', 'naval surface-to-air missile system', 'frigate', 'submarine', 'nuclear submarine', 'tank'].map(d => classifyWeapon(d)))
      .toEqual(['sph', 'ifv', 'mrl', 'sam', null, 'frigate', 'ssk', null, null]);
    expect(classifyWeapon('air defence system', 'DragonFire')).toBe('laser');
    expect(plannedEnd('delivery planned 2027-2029')).toBe(2029);
    expect(plannedEnd('K-9A1 version; delivery planned by 2028')).toBe(2028);
    expect(dealValue("AUD7.3 b ($4.5-5 b) 'Project Land-400'")).toBe(4500);
    expect(dealValue('AUD1 b ($667 m) deal')).toBe(667);
  });
});

describe('수집 스크립트(가짜 네트워크, SQLite)', () => {
  const repo = repository();
  it('드라이런은 DB를 건드리지 않는다', async () => {
    const result = await ingestUcdp({ dryRun: true, file: fixture('ucdp-brd.csv'), now: NOW, repo });
    expect(result.dryRun).toBe(true);
    expect(result.rows.pair_events!.length).toBeGreaterThan(0);
    expect(await selectRows(repo, 'pair_events')).toEqual([]);
  });

  it('SIPRI 이전: POST 본문 → signals(계약·인도)·inventory(누적 추정), 출처·신뢰도·수집일 기록', async () => {
    const calls: string[] = []; let body: any;
    const csv = readFileSync(fixture('sipri-transfers.csv'), 'utf8');
    const fetch = mockFetch({ [SIPRI_TRANSFERS_URL]: init => { body = JSON.parse(String(init?.body)); return JSON.stringify({ bytes: Buffer.from(csv, 'latin1').toString('base64') }); } }, calls);
    const result = await ingestSipriTransfers({ fetch, now: NOW, repo, year: 2025 });
    expect(calls).toEqual([SIPRI_TRANSFERS_URL]);
    expect(body.filters[0]).toMatchObject({ field: 'Order year', value1: 1985, value2: 2025 });
    expect(result.notes.join()).toContain('주문 연도 1985~2025');
    const signals = await selectRows(repo, 'signals');
    expect(signals.map(s => s.id).sort()).toEqual(['sipri:AUS:south-korea:k-21:2023', 'sipri:EGY:south-korea:k-9-thunder-155mm:2022', 'sipri:EST:south-korea:k-9-thunder-155mm:2023', 'sipri:POL:south-korea:k-9-thunder-155mm:2022', 'sipri:POL:south-korea:k-9-thunder-155mm:2023']);
    const pol = signals.find(s => s.id === 'sipri:POL:south-korea:k-9-thunder-155mm:2023')!;
    expect(pol).toMatchObject({ country: 'POL', system: 'sph', supplier: 'KOR', stage: 'contract', quantity: 152, expected_year: 2027, source_id: 'sipri_transfers', confidence: 1, collected_at: NOW });
    const inventory = await selectRows(repo, 'inventory', { country: 'POL' });
    expect(inventory.map(i => [i.system, i.quantity, i.delivered_year, i.retire_year, i.confidence]).sort()).toEqual([['sam', 2, 2023, 2053, 0.7], ['sph', 212, 2025, 2060, 0.7]]);
    expect((await selectRows(repo, 'inventory', { country: 'EST' }))).toEqual([]); // 인도 전 중고 계약은 보유로 넣지 않는다
    expect((await repo.one('SELECT data FROM sources WHERE id=?', 'sipri_transfers'))?.data).toContain('"collectedAt":"2026-10-21T00:00:00.000Z"');
    // 다시 넣어도 행이 늘지 않는다(멱등)
    await ingestSipriTransfers({ fetch, now: NOW, repo, year: 2025 });
    expect((await selectRows(repo, 'signals')).length).toBe(5);
  });

  it('SIPRI 국방비(XLSX)와 World Bank: 실질 증가율·GDP 비율, 기존 값 보존', async () => {
    await ingestSipriMilex({ fetch: mockFetch({ 'https://www.sipri.org/': () => new Response(Buffer.from(milexBook())) }), now: NOW, repo, year: 2025 });
    const pol = await selectRows(repo, 'budgets', { country: 'POL' });
    expect(pol.find(b => b.year === 2025)).toMatchObject({ usd_m: 46760.1, gdp_pct: 4.5, yoy_pct: 21.2, source_id: 'sipri_milex' });
    expect((await selectRows(repo, 'budgets', { country: 'UKR' })).map(b => b.year)).toEqual([2021, 2022]);
    const calls: string[] = [];
    const fetch = mockFetch({
      'https://api.worldbank.org/v2/country/all/indicator/MS.MIL.XPND.GD.ZS': () => wb([['POL', '2025', 4.2], ['WLD', '2025', 2.5], ['EST', '2025', 3.4]]),
      'https://api.worldbank.org/v2/country/all/indicator/MS.MIL.XPND.CD': () => wb([['POL', '2025', 40000e6], ['EST', '2025', 1500e6]]),
      'https://api.worldbank.org/v2/country/all/indicator/NY.GDP.MKTP.CD': () => wb([['POL', '2025', 1039000e6], ['EST', '2025', 44000e6]]),
    }, calls);
    await ingestWorldBank({ fetch, now: NOW, repo, year: 2025 });
    expect(calls).toHaveLength(3);
    const after = (await selectRows(repo, 'budgets', { country: 'POL' })).find(b => b.year === 2025)!;
    expect(after).toMatchObject({ usd_m: 46760.1, gdp_pct: 4.5, gdp_usd_m: 1039000, source_id: 'sipri_milex' }); // SIPRI 값 유지, GDP만 추가
    expect((await selectRows(repo, 'budgets', { country: 'EST' }))[0]).toMatchObject({ usd_m: 1500, gdp_pct: 3.4, source_id: 'worldbank_wdi' });
    expect(await selectRows(repo, 'budgets', { country: 'WLD' })).toEqual([]);
    // SIPRI를 다시 넣어도 World Bank GDP가 지워지지 않는다
    await ingestSipriMilex({ fetch: mockFetch({ 'https://www.sipri.org/': () => new Response(Buffer.from(milexBook())) }), now: NOW, repo, year: 2025 });
    expect((await selectRows(repo, 'budgets', { country: 'POL', year: 2025 }))[0].gdp_usd_m).toBe(1039000);
  });

  it('금수·ITAR → export_controls(비국가 대상·비구속은 partial)', async () => {
    await ingestSipriEmbargoes({ file: fixture('sipri-embargoes.html'), now: NOW, repo });
    await ingestItar({ fetch: mockFetch({ 'https://www.law.cornell.edu/': () => readFileSync(fixture('itar-126-1.html'), 'utf8') }), now: NOW, repo });
    const rows = await selectRows(repo, 'export_controls');
    const by = (country: string) => rows.filter(r => r.country === country).map(r => `${r.regime}:${r.status}`).sort();
    expect(by('PRK')).toEqual(['UN:active', 'US-ITAR-126.1(d)(1):active']);
    expect(by('LBN')).toEqual(['UN:partial']);
    expect(by('AGO')).toEqual(['UN:lifted']);
    expect(by('EGY')).toEqual(['EU:partial']);
    expect(by('RUS')).toEqual(['EU:active', 'US-ITAR-126.1(d)(2):partial']);
    expect(rows.find(r => r.country === 'PRK' && r.regime === 'UN')).toMatchObject({ started: '2006-10-14', source_id: 'sipri_embargoes', url: 'https://www.sipri.org/databases/embargoes/un_arms_embargoes/north-korea' });
  });

  it('UCDP·GDELT·Oryx → pair_events·consumption', async () => {
    await ingestUcdp({ fetch: mockFetch({ 'https://ucdp.uu.se/': () => new Response(Buffer.from(zipSync({ 'BattleDeaths_v26_1.csv': strToU8(readFileSync(fixture('ucdp-brd.csv'), 'utf8')) }))) }), now: NOW, repo, year: 2026 });
    const ucdp = await selectRows(repo, 'pair_events', { source: ['ucdp', 'ucdp_intl'] });
    expect(ucdp.map(e => `${e.source}:${e.country}-${e.counterpart}:${e.period}:${e.fatalities}`)).toEqual([
      'ucdp:IND-PAK:2025:67', 'ucdp:RUS-UKR:2024:102120', 'ucdp:RUS-UKR:2025:94741', 'ucdp_intl:GBR-YEM:2025:781', 'ucdp_intl:USA-YEM:2025:781',
    ]);
    const day = [gdeltLine('IND', 'PAK', '19', -10), gdeltLine('PAK', 'IND', '13', -4), gdeltLine('IND', 'PAK', '04', 1), gdeltLine('ROM', 'RUS', '17', -5), gdeltLine('IND', '', '19', -10), gdeltLine('EUR', 'RUS', '19', -10)].join('\n');
    expect([...tallyDay(day)]).toEqual([['IND|PAK', { events: 2, goldsteinSum: -14 }], ['ROU|RUS', { events: 1, goldsteinSum: -5 }]]);
    const zip = zipSync({ 'x.export.CSV': strToU8(day) }), calls: string[] = [];
    await ingestGdelt({ fetch: mockFetch({ 'https://data.gdeltproject.org/events/': () => new Response(Buffer.from(zip)) }, calls), now: NOW, repo, args: { months: '1', days: '1,15' } });
    expect(calls).toEqual([gdeltDayUrl('2026-09-01'), gdeltDayUrl('2026-09-15')]);
    expect((await selectRows(repo, 'pair_events', { source: 'gdelt' })).map(e => [e.country, e.counterpart, e.period, e.events, e.goldstein, e.confidence])).toEqual([['IND', 'PAK', '2026-09', 60, -7, 0.7], ['ROU', 'RUS', '2026-09', 30, -5, 0.7]]);
    calls.length = 0;
    const again = await ingestGdelt({ fetch: mockFetch({}, calls), now: NOW, repo, args: { months: '1' } });
    expect(calls).toEqual([]); // 이미 적재된 달은 다시 받지 않는다
    expect(again.notes[0]).toContain('2026-09');
    await ingestOryx({ file: fixture('oryx-russia.html'), now: NOW, repo, args: { side: 'RUS' } });
    const losses = await selectRows(repo, 'consumption');
    expect(losses.map(c => `${c.system}:${c.model}:${c.quantity}`).sort()).toEqual(['frigate:Project 1135 Burevestnik-class frigate:1', 'ifv:BMP-2:10', 'ifv:BMP-3:2', 'mrl:122mm BM-21 Grad:3', 'sph:152mm 2S19 Msta-S:5', 'ssk:Project 636.3 Kilo-class submarine:1']);
    expect(losses[0]).toMatchObject({ user_country: 'RUS', target_country: 'UKR', kind: 'loss', conflict: 'russia-ukraine-2022', source_id: 'oryx_ukraine', confidence: 0.7, period: '2022-02~2026-10' });
  });

  it('등급·긴장도 작업 후 판단 점수(통과 조건·근거 ID)', async () => {
    const tiers = await ingestTiers({ now: NOW, repo, year: 2026 });
    expect(tiers.notes.join()).toContain('국가');
    const tier = async (country: string, system = '*') => (await selectRows(repo, 'export_tiers', { country, system }))[0];
    expect((await tier('PRK')).tier).toBe(3);
    expect((await tier('RUS')).tier).toBe(3); // 한국 수출통제(수기 목록)
    expect((await tier('POL')).tier).toBe(1);
    expect((await tier('POL')).tier_reasons.reasons[0].evidence).toContain('signals:sipri:POL:south-korea:k-9-thunder-155mm:2022');
    // 이집트·중국은 수기 지정으로 수출 불가(사유와 근거 ID 포함)
    for (const c of ['EGY', 'CHN']) {
      const t = await tier(c);
      expect(t.tier).toBe(3);
      const manual = t.tier_reasons.reasons.find(r => r.code === 'embargo:MANUAL');
      expect(manual).toMatchObject({ tier: 3, evidence: [`export_controls:MANUAL:${c}`] });
      expect(manual!.text).toContain('수출 불가');
    }
    expect((await tier('IND')).tier_reasons.reasons.map(r => r.code)).toContain('conflict-party');
    expect((await tier('FRA')).tier).toBe(2); // 한국산 이력 없음
    expect((await tier('POL', 'laser')).tier_reasons.approvals).toContain('laser 체계의 미국산 부품 사용 여부 미확인');

    const tension = await ingestTension({ now: NOW, repo });
    expect(tension.notes[0]).toContain('기준 2026-09');
    const near = await selectRows(repo, 'neighbors', { country: 'IND', neighbor: 'PAK' });
    expect(near[0]).toMatchObject({ kind: 'land' });
    expect(near[0].tension).toBeGreaterThan(50);
    expect((near[0].components as any).territory.dispute).toBe('카슈미르');
    const pr = (await selectRows(repo, 'neighbors', { country: 'POL', neighbor: 'RUS' }))[0];
    expect((pr.components as any).alliance).toBeNull();
    expect((await selectRows(repo, 'neighbors', { country: 'POL', neighbor: 'DEU' }))[0].components).toMatchObject({ alliance: { name: 'NATO' } });

    const score = computeScore(await scoringInputs(repo, 'POL', 'sph'), 2026);
    expect(score.gate.passed).toBe(true);
    expect(score.tier).toBe(1);
    expect(score.components.find(c => c.factor === 'fiscal')!.points).toBeGreaterThan(0);
    expect(score.components.find(c => c.factor === 'neighbor')!.evidence.some(e => e.startsWith('neighbors:POL:'))).toBe(true);
    expect(score.evidenceIds).toContain('export_tiers:POL:sph'); // 체계별 등급이 국가 단위보다 먼저 쓰인다
    expect(score.components.find(c => c.factor === 'neighbor')!.detail).not.toContain('700%'); // 2022년 우크라이나 급증은 3년 창 밖
    const prk = computeScore(await scoringInputs(repo, 'PRK', 'sph'), 2026);
    expect(prk).toMatchObject({ score: 0, grey: true, tier: 3 });
  });
});
