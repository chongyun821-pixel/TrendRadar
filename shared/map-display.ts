/** 지도 표시 조정(챗봇 화면 제어): 국가 숨기기·특정 국가만 표시·강조, 빗금·막대·범례 켜고 끄기 */
export interface MapDisplay {
  /** 색·빗금·막대를 감출 국가(ISO 3자리) */
  hidden: string[];
  /** 이 국가들만 표시한다. null이면 전체 */
  only: string[] | null;
  /** 강조할 국가. 비어 있지 않으면 나머지 국가를 어둡게 한다 */
  highlight: string[];
  hatch: boolean;
  bars: boolean;
  legend: boolean;
}
export type MapDisplayPatch = Partial<MapDisplay> & { reset?: boolean };
export type MapZoom = 'in' | 'out' | 'reset' | number;

export const DEFAULT_DISPLAY: MapDisplay = { hidden: [], only: null, highlight: [], hatch: true, bars: true, legend: true };

export function applyDisplayPatch(current: MapDisplay, patch: MapDisplayPatch): MapDisplay {
  const base = patch.reset ? DEFAULT_DISPLAY : current;
  const { reset: _reset, ...rest } = patch;
  return { ...base, ...rest };
}
export const isDefaultDisplay = (d: MapDisplay) => !d.hidden.length && !d.only && !d.highlight.length && d.hatch && d.bars && d.legend;

/** 숨김·특정 국가만 표시를 반영해 이 국가를 지도에 칠할지 */
export function displayShows(d: MapDisplay, id: string) {
  return !d.hidden.includes(id) && (!d.only || d.only.includes(id));
}

type Rgb = [number, number, number];
/** 강조 대상이 아닌 국가(색·막대)는 바탕색 쪽으로 어둡게 한다 */
const DIM = 0.12;
/** 자료가 없는 국가를 강조할 때 쓰는 밝은 회색 */
export const dimRgb = (rgb: Rgb, base: Rgb) => rgb.map((v, i) => base[i] + (v - base[i]) * DIM) as Rgb;
/** 강조한 국가는 원래 색이 어두워도(교체 시기가 먼 국가) 눈에 띄도록 밝게 올린다 */
export const liftRgb = (rgb: Rgb) => rgb.map(v => Math.min(1, v * 1.4 + 0.2)) as Rgb;
export const HIGHLIGHT_EMPTY_RGB: Rgb = [0.46, 0.52, 0.6];

/** 지도 색·빗금에 표시 조정을 적용한다. 반환한 shows로 막대 표시 여부도 정한다 */
export function displayStyle(d: MapDisplay, colors: Map<string, Rgb>, hatched: ReadonlySet<string>, base: Rgb) {
  const out = new Map<string, Rgb>(), hatch = new Set<string>();
  const focus = new Set(d.highlight);
  for (const [id, rgb] of colors) {
    if (!displayShows(d, id)) continue;
    out.set(id, !focus.size ? rgb : focus.has(id) ? liftRgb(rgb) : dimRgb(rgb, base));
    if (d.hatch && hatched.has(id) && (!focus.size || focus.has(id))) hatch.add(id);
  }
  for (const id of focus) if (displayShows(d, id) && !out.has(id)) out.set(id, HIGHLIGHT_EMPTY_RGB);
  return { colors: out, hatched: hatch, shows: (id: string) => displayShows(d, id), dimmed: (id: string) => focus.size > 0 && !focus.has(id) };
}

/** 범례에 붙이는 현재 표시 조정 요약. 기본 상태면 빈 문자열 */
export function displaySummary(d: MapDisplay, name: (id: string) => string) {
  const list = (ids: string[]) => ids.length <= 3 ? ids.map(name).join('·') : `${ids.slice(0, 3).map(name).join('·')} 외 ${ids.length - 3}개국`;
  return [
    d.only ? `표시 ${list(d.only)}` : '',
    d.hidden.length ? `숨김 ${list(d.hidden)}` : '',
    d.highlight.length ? `강조 ${list(d.highlight)}` : '',
    d.hatch ? '' : '빗금 끔',
    d.bars ? '' : '막대 끔',
  ].filter(Boolean).join(' · ');
}
