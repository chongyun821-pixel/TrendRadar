import type { Seed } from './types';

// Static ISO 3166-1 alpha-3 display names, with non-ISO entries and historic
// codes required by the map and procurement data.
const STATIC_NAMES: Record<string, string> = {
  AFG: '아프가니스탄', ALB: '알바니아', DZA: '알제리', AND: '안도라', AGO: '앙골라', ATG: '앤티가 바부다', ARG: '아르헨티나', ARM: '아르메니아', AUS: '호주', AUT: '오스트리아', AZE: '아제르바이잔',
  BHS: '바하마', BHR: '바레인', BGD: '방글라데시', BRB: '바베이도스', BLR: '벨라루스', BEL: '벨기에', BLZ: '벨리즈', BEN: '베냉', BTN: '부탄', BOL: '볼리비아', BIH: '보스니아 헤르체고비나', BWA: '보츠와나', BRA: '브라질', BRN: '브루나이', BGR: '불가리아', BFA: '부르키나파소', BDI: '부룬디',
  CPV: '카보베르데', KHM: '캄보디아', CMR: '카메룬', CAN: '캐나다', CAF: '중앙아프리카 공화국', TCD: '차드', CHL: '칠레', CHN: '중국', COL: '콜롬비아', COM: '코모로', COG: '콩고 공화국', CRI: '코스타리카', CIV: '코트디부아르', HRV: '크로아티아', CUB: '쿠바', CYP: '키프로스', CZE: '체코', COD: '콩고 민주 공화국',
  DNK: '덴마크', DJI: '지부티', DMA: '도미니카', DOM: '도미니카 공화국', ECU: '에콰도르', EGY: '이집트', SLV: '엘살바도르', GNQ: '적도 기니', ERI: '에리트레아', EST: '에스토니아', SWZ: '에스와티니', ETH: '에티오피아', FJI: '피지', FIN: '핀란드', FRA: '프랑스', GAB: '가봉', GMB: '감비아', GEO: '조지아', DEU: '독일', GHA: '가나', GRC: '그리스', GRD: '그레나다', GTM: '과테말라', GIN: '기니', GNB: '기니비사우', GUY: '가이아나', HTI: '아이티', HND: '온두라스', HUN: '헝가리', ISL: '아이슬란드', IND: '인도', IDN: '인도네시아', IRN: '이란', IRQ: '이라크', IRL: '아일랜드', ISR: '이스라엘', ITA: '이탈리아', JAM: '자메이카', JPN: '일본', JOR: '요르단', KAZ: '카자흐스탄', KEN: '케냐', KIR: '키리바시', PRK: '북한', KOR: '대한민국', KWT: '쿠웨이트', KGZ: '키르기스스탄', LAO: '라오스', LVA: '라트비아', LBN: '레바논', LSO: '레소토', LBR: '라이베리아', LBY: '리비아', LIE: '리히텐슈타인', LTU: '리투아니아', LUX: '룩셈부르크', MDG: '마다가스카르', MWI: '말라위', MYS: '말레이시아', MDV: '몰디브', MLI: '말리', MLT: '몰타', MHL: '마셜 제도', MRT: '모리타니', MUS: '모리셔스', MEX: '멕시코', FSM: '미크로네시아', MDA: '몰도바', MCO: '모나코', MNG: '몽골', MNE: '몬테네그로', MAR: '모로코', MOZ: '모잠비크', MMR: '미얀마', NAM: '나미비아', NRU: '나우루', NPL: '네팔', NLD: '네덜란드', NZL: '뉴질랜드', NIC: '니카라과', NER: '니제르', NGA: '나이지리아', MKD: '북마케도니아', NOR: '노르웨이', OMN: '오만', PAK: '파키스탄', PLW: '팔라우', PAN: '파나마', PNG: '파푸아뉴기니', PRY: '파라과이', PER: '페루', PHL: '필리핀', POL: '폴란드', PRT: '포르투갈', QAT: '카타르', ROU: '루마니아', RUS: '러시아', RWA: '르완다', KNA: '세인트키츠 네비스', LCA: '세인트루시아', VCT: '세인트빈센트 그레나딘', WSM: '사모아', SMR: '산마리노', STP: '상투메 프린시페', SAU: '사우디아라비아', SEN: '세네갈', SRB: '세르비아', SYC: '세이셸', SLE: '시에라리온', SGP: '싱가포르', SVK: '슬로바키아', SVN: '슬로베니아', SLB: '솔로몬 제도', SOM: '소말리아', ZAF: '남아프리카 공화국', SSD: '남수단', ESP: '스페인', LKA: '스리랑카', SDN: '수단', SUR: '수리남', SWE: '스웨덴', CHE: '스위스', SYR: '시리아', TJK: '타지키스탄', THA: '태국', TLS: '동티모르', TGO: '토고', TON: '통가', TTO: '트리니다드 토바고', TUN: '튀니지', TUR: '튀르키예', TKM: '투르크메니스탄', TUV: '투발루', UGA: '우간다', UKR: '우크라이나', ARE: '아랍에미리트', GBR: '영국', TZA: '탄자니아', USA: '미국', URY: '우루과이', UZB: '우즈베키스탄', VUT: '바누아투', VEN: '베네수엘라', VNM: '베트남', YEM: '예멘', ZMB: '잠비아', ZWE: '짐바브웨',
  TWN: '대만', XKX: '코소보', PSE: '팔레스타인', PSX: '팔레스타인',
  SUN: '소련', CSK: '체코슬로바키아',
};

export function countryName(code: string, data?: Pick<Seed, 'countries'>): string {
  return data?.countries[code]?.ko || STATIC_NAMES[code] || code;
}
