import type { Seed, SystemKey } from './types';
import { countryName } from './country-name';

export const COUNTRY_BRIEF_TEMPLATE_ID = 'word-map-brief-v1';

/** The map button submits an explicit scope so later map changes cannot change the research target. */
export function countryBriefRequest(country: string, system: SystemKey, data: Seed): string {
  const name = countryName(country, data), weapon = data.systems[system].ko;
  return [
    `${name} ${weapon}의 부족한 정보를 추가 조사하고, 경영진용 Word 요약 보고서 1~2쪽을 작성해 주세요.`,
    `대상은 국가 ${country}, 무기체계 ${system}입니다. 작업 중 지도 선택이 바뀌어도 이 대상을 유지하세요.`,
    'DB의 구조화 자료와 연결된 보존 원문을 우선 확인하세요. 원문 source ID는 source_read로 읽고, 보존 원문이 없거나 최신성 또는 완전성이 부족한 항목만 웹에서 추가 수집하세요.',
    'get_country_data_status와 research_procurement로 현재 보유 장비, 도입 연도, 수량, 조달 단계와 일정, 금액, 경쟁 구도 및 원문 근거의 누락과 오래된 정보를 먼저 확인하세요. 부족하거나 상충하는 항목을 실제 검색과 원문 읽기로 조사하고 출처를 보존하세요. 확인된 보완 자료는 기존 정제, 검증, 반영 도구로 갱신하고 마지막에 자료 상태를 다시 확인하세요. 확인 불가, 접근 실패, 추정은 그대로 구분하고 임의의 수치를 채우지 마세요.',
    `조사 후 get_report_template(templateId="${COUNTRY_BRIEF_TEMPLATE_ID}")와 prepare_report(country="${country}", system="${system}", templateId="${COUNTRY_BRIEF_TEMPLATE_ID}", basis="latest")로 최신 작성 자료를 고정하세요.`,
    '현재 가로형 보고서 PDF와 PPT의 한화 로고, 남색과 주황색, HORUS 표기, 표 스타일을 참고한 A4 세로 1~2쪽 요약 양식을 사용하세요. 별도 표지 없이 핵심 판단, 현재 전력과 교체 시기 및 규모, 진행 사업과 한화 기회, 남은 불확실성, 주요 출처를 간결하게 작성하세요. HORUS의 풀 네임은 Hanwha Observation & Reconnaissance Unified System입니다.',
    '현재 모델의 기본 Word 작성 스킬과 문서 도구로 편집 가능한 .docx를 직접 작성하세요. 모든 페이지를 렌더링해 실제 1~2쪽인지, 표와 글자가 잘리지 않는지 확인하고 필요하면 수정하세요. 완성 파일만 publish_artifact(path, preparationId, review)로 등록하고 반환된 다운로드 링크를 제공하세요. 자료를 끝내 확인하지 못한 경우에도 미확인 사항을 명시한 요약 보고서를 작성하세요.',
  ].join('\n\n');
}
