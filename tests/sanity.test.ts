import { describe, it, expect } from 'vitest';
import { app, sameOrigin } from '../server/app';
import { writeReport } from '../shared/tools';
import { robotsAllowed } from '../server/sources';
import { repository } from '../server/store';
import { scoreSystem } from '../server/scoring';
import { computeForecast } from '../shared/forecast';

describe('코드 점검 수정', () => {
  it('다른 출처의 쓰기 요청은 거절하고, Origin 없는 도구 호출과 같은 출처 요청은 받는다', async () => {
    expect(sameOrigin(undefined, 'localhost:62356')).toBe(true);
    expect(sameOrigin('http://localhost:62356', 'localhost:62356')).toBe(true);
    expect(sameOrigin('https://evil.example', 'localhost:62356')).toBe(false);
    expect(sameOrigin('null', 'localhost:62356')).toBe(false);
    const evil = await app.request('http://localhost:62356/api/conversations', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'text/plain' } });
    expect(evil.status).toBe(403);
    const same = await app.request('http://localhost:62356/api/conversations', { method: 'POST', headers: { origin: 'http://localhost:62356' } });
    expect(same.status).toBe(201);
    expect((await app.request('http://localhost:62356/api/health', { headers: { origin: 'https://evil.example' } })).status).toBe(200);
  });
  it('알 수 없는 체계 이름은 전체 체계 보고서로 바꾸지 않는다', async () => {
    await repository().data();
    expect(writeReport({ country: 'POL', system: '없는체계' })).toEqual({ error: '무기체계를 찾지 못함' });
    expect('markdown' in writeReport({ country: 'POL', system: '일반' })).toBe(true);
    expect((await app.request('/api/report?country=POL&system=foo')).status).toBe(404);
  });
  it('robots.txt의 빈 User-agent는 이 수집기 전용 규칙으로 보지 않는다', () => {
    expect(robotsAllowed('User-agent:\nDisallow: /\n\nUser-agent: *\nAllow: /', '/page')).toBe(true);
    expect(robotsAllowed('User-agent: ProcurementRadar\nDisallow: /x', '/x')).toBe(false);
    expect(robotsAllowed('User-agent: TrendRadar\nDisallow: /x\n\nUser-agent: *\nAllow: /', '/x')).toBe(true); // 예전 이름은 더 이상 이 수집기가 아니다
  });
  it('판단 점수의 노후화는 점수와 같은 기준 연도의 예측을 쓴다', async () => {
    const repo = repository(), data = await repo.data();
    const record = data.records[0];
    const base = data.meta.baseYear;
    const [score] = await scoreSystem(repo, data, record.system, [record.country]);
    const f = computeForecast(record, data, base);
    const aging = score.components.find(c => c.factor === 'aging')!;
    if (!aging.missing && aging.evidence[0]?.startsWith('records:')) expect(aging.detail).toContain(`${f.window![0]}~${f.window![1]}`);
    expect(score.baseYear).toBe(base);
  });
});
