/** 한화 계열사 회사 이름은 국문으로 쓴다. 원문 인용(quote), 출처 제목(t, title), URL, ID, 장비 형식명(model)은 원문 그대로 둔다. */
const REGION: Record<string, string> = { australia: '오스트레일리아', usa: 'USA', 'u.s.': 'USA', us: 'USA', america: 'USA', romania: '루마니아', poland: '폴란드', europe: '유럽', canada: '캐나다', norway: '노르웨이', philippines: '필리핀', egypt: '이집트' };
const UNIT: [RegExp, string][] = [
  [/^philly\s+shipyard$/i, '한화필리조선소'],
  [/^wb\s+advanced\s+systems$/i, '한화WB어드밴스드시스템즈'],
  [/^aerospace$/i, '한화에어로스페이스'],
  [/^ocean$/i, '한화오션'],
  [/^systems?$/i, '한화시스템'],
  [/^defen[cs]e$/i, '한화디펜스'],
  [/^land\s+systems$/i, '한화지상방산'],
  [/^techwin$/i, '한화테크윈'],
  [/^(?:corporation|corp\.?|co\.?,?\s*ltd\.?)$/i, '(주)한화'],
  [/^group$/i, '한화그룹'],
];
const SUFFIX = '(?:Philly\\s+Shipyard|WB\\s+Advanced\\s+Systems|Aerospace|Ocean|Systems?|Defen[cs]e|Land\\s+Systems|Techwin|Corporation|Corp\\.?|Group)';
const REGION_RE = '(?:Australia|USA|U\\.S\\.|US|America|Romania|Poland|Europe|Canada|Norway|Philippines|Egypt)';
// 앞뒤가 영문자, 숫자, 하이픈, 밑줄, 점, 슬래시로 이어지면(ID, URL, Hanwha-70 같은 형식명) 바꾸지 않는다
const PATTERN = new RegExp(`(?<![A-Za-z0-9_./-])Hanwha(?:\\s+(${SUFFIX}))?(?:\\s+(${REGION_RE}))?(?![A-Za-z0-9_/-])`, 'gi');
/** 문자열 안의 한화 계열사 영문 이름을 국문으로 바꾼다 */
export function koreanizeHanwha(text: string): string {
  return text.replace(PATTERN, (match, unit?: string, region?: string) => {
    const name = unit ? UNIT.find(([re]) => re.test(unit.trim()))?.[1] ?? match : '한화';
    if (name === match) return match;
    return region ? `${name} ${REGION[region.toLowerCase()] ?? region}` : name;
  });
}
const SKIP_KEYS = new Set(['id', 'src', 'sourceId', 'source_id', 'quote', 'quotes', 't', 'title', 'u', 'url', 'model', 'models', 'aliases', 'sources', 'evidence', 'hash']);
const NAME_KEYS = new Set(['supplier', 'maker', 'manufacturer', 'prime', 'partner', 'partners', 'contractor', 'builder', 'reserve', 'vendor', 'bidder', 'bidders', 'competitors']);
const HANGUL = /[가-힣]/;
/** 저장 전 정리: 회사 이름 필드는 항상, 그 밖의 서술 문장은 국문 문장(한글 포함)일 때만 바꾼다. 원문 인용, 출처, ID는 건드리지 않는다 */
export function koreanizeHanwhaDeep<T>(value: T, key = ''): T {
  if (SKIP_KEYS.has(key)) return value;
  if (typeof value === 'string') return (NAME_KEYS.has(key) || HANGUL.test(value) ? koreanizeHanwha(value) : value) as T;
  if (Array.isArray(value)) return value.map(v => koreanizeHanwhaDeep(v, NAME_KEYS.has(key) ? key : '')) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, koreanizeHanwhaDeep(v, k)])) as T;
  return value;
}