import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { countryBriefRequest, COUNTRY_BRIEF_TEMPLATE_ID } from '../shared/country-brief';
import { seed } from '../shared/data';
import { repository, now } from '../server/store';
import { executions } from '../server/execution';
import { reportTool } from '../server/reporting';
import { SYSTEM_KEYS } from '../shared/types';

describe('지도 Word 요약 보고서', () => {
  it('대상과 추가 조사, 분량, 검수 및 등록 조건을 함께 요청한다', () => {
    const request = countryBriefRequest('POL', 'sph', seed);
    expect(request).toContain('국가 POL, 무기체계 sph');
    expect(request).toContain('get_country_data_status');
    expect(request).toContain('원문 읽기');
    expect(request).toContain(COUNTRY_BRIEF_TEMPLATE_ID);
    expect(request).toContain('1~2쪽');
    expect(request).toContain('모든 페이지를 렌더링');
    expect(request).toContain('publish_artifact(path, preparationId, review)');
  });

  it('고정 작성 자료에 한화 스타일과 실제 로고 파일을 보존한다', async () => {
    const repo = repository(), c = await repo.createConversation(), runId = randomUUID();
    await repo.run('INSERT INTO runs(id,conversation_id,model,status,started_at) VALUES(?,?,?,?,?)', runId, c.id, 'codex', 'running', now());
    const context = { repo, conversationId: c.id, runId, signal: new AbortController().signal, env: {} };
    const packet: any = await executions.run(context, () => reportTool('prepare_report', { country: 'POL', system: 'sph', templateId: COUNTRY_BRIEF_TEMPLATE_ID, basis: 'latest' }));
    expect(packet.template.style).toMatchObject({ navy: '#204d79', orange: '#f37221', fullName: 'Hanwha Observation & Reconnaissance Unified System' });
    expect(packet.template.instructions).toContain('A4 세로 1~2쪽');
    expect(packet.template.assets).toHaveLength(1);
    const logo = readFileSync(repo.path(c.id, packet.template.assets[0].path));
    expect(logo.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(packet.evidenceTables.length).toBeGreaterThan(0);
    const missing = Object.keys(seed.countries).flatMap(country => SYSTEM_KEYS.map(system => ({ country, system }))).find(pair => !seed.records.some(record => record.country === pair.country && record.system === pair.system));
    expect(missing).toBeDefined();
    const partial: any = await executions.run(context, () => reportTool('prepare_report', { ...missing, templateId: COUNTRY_BRIEF_TEMPLATE_ID, basis: 'latest' }));
    expect(partial.records).toEqual([]);
    expect(partial.forecasts).toEqual([]);
    expect(partial.evidenceTables).toHaveLength(1);
  });
});
