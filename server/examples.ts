import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, AppError } from './store';
import { ROOT } from './config';
import { addAttachment } from './attachments';

export const WORLD_BANK_CASE = {
  id: 'h5s-world-bank',
  title: '월드은행 적자 축소',
  description: '첨부 H5S 교재의 가상 은행 사례로 컨설팅을 시작합니다.',
  image: '20261021_191849.jpg',
  story: `# 월드은행 적자 축소 — H5S 교재의 가상 교육 사례

이 사례의 월드은행은 교재 속 국내 소매은행이다. 실제 국제기구 World Bank의 현황이 아니다. 사진에 제시된 교육용 설정만 사용한다.

## 해결해야 할 기본 질문
월드은행이 2026년까지 현재의 1억 달러 적자를 줄이고 향후 지속 가능한 운영 결과를 구축할 수 있는 방법은 무엇인가?

## 문제의 배경
- 금융업계: 업종 간 경계 약화로 경쟁이 격화되고 있다.
- 은행업계: 기존 은행 간 통폐합이 가속되고 채널의 중요성이 증대되고 있다.
- 경쟁사: 규제 완화로 인터넷 은행 등 저비용 형태의 경쟁사가 등장하고 있다.
- 월드은행: 점유율과 마진율이 급속히 하락하고 있으며, 연 1억 달러 적자가 발생하고 온라인 채널이 미비하다.

## 성공 측정 기준
교재는 2년 내 NIMs를 2010년 수준으로 회복하고 적자를 제거하여 수지 균형을 달성하는 목표를 제시한다. 2010년 NIM 실측값과 목표의 기준시점은 제공되지 않았다. 2026년은 교재 속 목표연도이며 실제 현재 날짜를 기준으로 목표를 임의 변경하지 않는다.

## 의사결정자
은행장, 이사회, 기획본부장, 영업본부장, 채널본부장.

## 주요 이해관계자
주주, 노동조합, 규제당국.

## 해결 방안에 대한 제약사항
- 은행을 독립적인 회사로 운영해야 한다.
- 자본시장법에 규정된 사업에 한한다는 것이 교재의 제약 설정이다. 실제 법률 검토가 완료되었다는 의미가 아니다.

## 해결 방안의 범위
국내시장과 소매금융시장에 한정한다.

## 출처와 미확인 사항
출처: 사용자가 제공한 한화 H5S 교재 사진 참고자료/20261021_191849.jpg, 「[예시] 문제정의서 — 월드은행 적자 축소」. 현재 대화에 원본 사진 사본을 첨부한다.
부문별 손익, 고객별 수익성, 실제 NIM, 채널별 원가, 고객 이탈률, 예산, 실행 담당자와 일정은 제공되지 않았다. 이런 값은 창작하지 않고 확인 필요로 표시한다. 분석 전의 판단은 초기가설로 구분한다. 실행 방향이나 일정이 필요하면 제안·가정임을 명시한다.
`,
};
export function exampleList() { return [{ id: WORLD_BANK_CASE.id, title: WORLD_BANK_CASE.title, description: WORLD_BANK_CASE.description }]; }
export async function createExample(store: Store, exampleId: string) {
  if (exampleId !== WORLD_BANK_CASE.id) throw new AppError('예시를 찾을 수 없습니다.', 404);
  const imageBytes = readFileSync(join(ROOT, '참고자료', WORLD_BANK_CASE.image));
  const report = store.create(`${WORLD_BANK_CASE.title} · 교재 사례`, WORLD_BANK_CASE.story, null, 'chat');
  await addAttachment(store, report.id, '월드은행_교육사례.md', 'text/markdown', Buffer.from(WORLD_BANK_CASE.story, 'utf8'));
  await addAttachment(store, report.id, WORLD_BANK_CASE.image, 'image/jpeg', imageBytes);
  return store.get(report.id);
}
export const EXAMPLE_OPENING = '첨부한 H5S 교재의 월드은행 적자 축소 사례로 컨설팅을 도와줘. 자료의 배경·목표·범위를 확인하고 핵심 검토 방향을 짧게 정리해줘. 아직 보고서 작성 화면은 열지 마. 실제 기업 자료가 아닌 교육용 가상 사례이며, 제공되지 않은 수치는 미확인으로 표시해줘.';
