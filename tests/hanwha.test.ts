import { describe, expect, it } from 'vitest';
import { koreanizeHanwha, koreanizeHanwhaDeep } from '../shared/hanwha';

describe('한화 계열사 국문 표기', () => {
  it('계열사 영문 이름을 국문으로 바꾼다', () => {
    expect(koreanizeHanwha('미선정 (Hanwha Ocean 및 유럽업체 경쟁)')).toBe('미선정 (한화오션 및 유럽업체 경쟁)');
    expect(koreanizeHanwha('Hanwha Aerospace (KOR)')).toBe('한화에어로스페이스 (KOR)');
    expect(koreanizeHanwha('LIG Nex1, Hanwha Systems')).toBe('LIG Nex1, 한화시스템');
    expect(koreanizeHanwha('Hanwha Defence Australia')).toBe('한화디펜스 오스트레일리아');
    expect(koreanizeHanwha('Hanwha Defense USA')).toBe('한화디펜스 USA');
    expect(koreanizeHanwha('Hanwha Aerospace Romania')).toBe('한화에어로스페이스 루마니아');
    expect(koreanizeHanwha('Hanwha WB Advanced Systems / Hanwha Aerospace (POL/KOR)')).toBe('한화WB어드밴스드시스템즈 / 한화에어로스페이스 (POL/KOR)');
    expect(koreanizeHanwha('Hanwha Philly Shipyard')).toBe('한화필리조선소');
    expect(koreanizeHanwha('Hanwha Corporation')).toBe('(주)한화');
    expect(koreanizeHanwha('L&T / Hanwha')).toBe('L&T / 한화');
    expect(koreanizeHanwha('폴란드 조달청과 Hanwha의 라이선스 계약')).toBe('폴란드 조달청과 한화의 라이선스 계약');
  });
  it('형식명, ID, URL은 그대로 둔다', () => {
    expect(koreanizeHanwha('Hanwha-70 70mm')).toBe('Hanwha-70 70mm');
    expect(koreanizeHanwha('pol_mrl_hanwha_ec3')).toBe('pol_mrl_hanwha_ec3');
    expect(koreanizeHanwha('https://hanwha-aerospace.eu/x')).toBe('https://hanwha-aerospace.eu/x');
  });
  it('저장 전 정리는 원문 인용, 출처 제목, ID, 형식명, 외국어 원문 메모를 건드리지 않는다', () => {
    const input = { id: 'SWE-ARCHER-HANWHA', reserve: 'Hanwha Ocean', supplier: 'Hanwha Aerospace', maker: 'Hanwha Systems', text: 'FMV는 Hanwha Aerospace와 계약을 발표했다.', model: 'Hanwha-70 70mm', note: 'Ministarstvo obrane od tvrtke Hanwha Aerospace nabavlja', quote: 'Hanwha Aerospace signed', t: 'Hanwha Aerospace inks deal', src: ['swe_hanwha'] };
    expect(koreanizeHanwhaDeep(input)).toEqual({ ...input, supplier: '한화에어로스페이스', maker: '한화시스템', reserve: '한화오션', text: 'FMV는 한화에어로스페이스와 계약을 발표했다.' });
    expect(koreanizeHanwhaDeep({ sources: { a: { t: 'Hanwha Ocean wins' } }, evidence: [{ quote: 'Hanwha Ocean' }] })).toEqual({ sources: { a: { t: 'Hanwha Ocean wins' } }, evidence: [{ quote: 'Hanwha Ocean' }] });
  });
});