import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPLAY, applyDisplayPatch, displayStyle, displaySummary, HIGHLIGHT_EMPTY_RGB } from '../shared/map-display';
import { mapTarget, appContextSchema, SCREEN_DEFS } from '../server/app-context';

type Rgb = [number, number, number];
const base: Rgb = [0, 0, 0];
const colors = new Map<string, Rgb>([['POL', [1, 1, 1]], ['ROU', [0.5, 0.5, 0.5]], ['CHN', [1, 0, 0]]]);
const hatched = new Set(['ROU', 'CHN']);

describe('지도 표시 조정', () => {
  it('숨김·특정 국가만 표시는 색·빗금·막대에서 빠진다', () => {
    const hide = displayStyle({ ...DEFAULT_DISPLAY, hidden: ['CHN'] }, colors, hatched, base);
    expect([...hide.colors.keys()]).toEqual(['POL', 'ROU']);
    expect([...hide.hatched]).toEqual(['ROU']);
    expect(hide.shows('CHN')).toBe(false);
    const only = displayStyle({ ...DEFAULT_DISPLAY, only: ['POL'] }, colors, hatched, base);
    expect([...only.colors.keys()]).toEqual(['POL']);
    expect(only.shows('ROU')).toBe(false);
  });
  it('강조는 나머지를 어둡게 하고 자료 없는 국가도 밝게 보인다', () => {
    const s = displayStyle({ ...DEFAULT_DISPLAY, highlight: ['POL', 'ROU', 'KOR'] }, colors, hatched, base);
    expect(s.colors.get('POL')).toEqual([1, 1, 1]);
    expect(s.colors.get('ROU')![0]).toBeCloseTo(0.9);
    expect(s.colors.get('CHN')![0]).toBeCloseTo(0.12);
    expect(s.colors.get('KOR')).toEqual(HIGHLIGHT_EMPTY_RGB);
    expect([...s.hatched]).toEqual(['ROU']);
  });
  it('빗금 끄기와 초기화', () => {
    expect(displayStyle({ ...DEFAULT_DISPLAY, hatch: false }, colors, hatched, base).hatched.size).toBe(0);
    const d = applyDisplayPatch({ ...DEFAULT_DISPLAY, hidden: ['CHN'], hatch: false }, { reset: true, legend: false });
    expect(d).toEqual({ ...DEFAULT_DISPLAY, legend: false });
    expect(displaySummary({ ...DEFAULT_DISPLAY, hidden: ['CHN'], hatch: false }, id => id)).toBe('숨김 CHN · 빗금 끔');
  });
  it('set_map_state가 확대·국가 목록·표시 켜고 끄기를 해석한다', async () => {
    const t = await mapTarget('set_map_state', { zoom: '확대', hide: '중국, 러시아', only: '해제', highlight: 'POL', hatch: false, bars: 'false', resetDisplay: true });
    expect(t).toEqual({ zoom: 'in', display: { reset: true, hidden: ['CHN', 'RUS'], only: null, highlight: ['POL'], hatch: false, bars: false } });
    expect((await mapTarget('set_map_state', { zoom: 7 })).zoom).toBe(7);
    await expect(mapTarget('set_map_state', { zoom: '20' })).rejects.toThrow('확대 값');
    await expect(mapTarget('set_map_state', { hide: '없는나라' })).rejects.toThrow('국가 확인 필요');
    const props = SCREEN_DEFS.find(d => d.name === 'set_map_state')!.properties;
    for (const key of ['zoom', 'hide', 'only', 'highlight', 'hatch', 'bars', 'legend', 'resetDisplay']) expect(props).toHaveProperty(key);
  });
  it('화면 맥락이 표시 조정을 받는다', () => {
    expect(appContextSchema.shape.display.safeParse({ ...DEFAULT_DISPLAY, only: ['POL'] }).success).toBe(true);
    expect(appContextSchema.shape.display.safeParse(undefined).success).toBe(true);
  });
});
