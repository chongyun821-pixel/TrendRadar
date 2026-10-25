import { describe, expect, it } from 'vitest';
import { isEditableTarget, shortcutAction } from '../src/shortcuts';
import { searchMatches, type SearchCountry, type SearchSystem } from '../src/search';

const countries: SearchCountry[] = [
  { id: 'POL', ko: '폴란드', en: 'Poland' },
  { id: 'FIN', ko: '핀란드', en: 'Finland' },
];
const systems: SearchSystem[] = [
  { id: 'sph', label: '자주포' },
  { id: 'ifv', label: 'IFV' },
];

describe('global shortcut mapping', () => {
  it('maps digits by displayed tab order and ignores digits beyond the list', () => {
    expect(shortcutAction({ key: '1' }, 7)).toEqual({ type: 'weapon', index: 0 });
    expect(shortcutAction({ key: '3' }, 7)).toEqual({ type: 'weapon', index: 2 });
    expect(shortcutAction({ key: '8' }, 7)).toBeNull();
  });

  it('maps view, chat and search shortcuts with modifier rules', () => {
    expect(shortcutAction({ key: 'R' }, 7)).toBe('report');
    expect(shortcutAction({ key: 'm' }, 7)).toBe('map');
    expect(shortcutAction({ key: 'g' }, 7)).toBe('globe');
    expect(shortcutAction({ key: 'Enter' }, 7)).toBe('chat');
    expect(shortcutAction({ key: 'f', ctrlKey: true }, 7)).toBe('search');
    expect(shortcutAction({ key: 'f', metaKey: true }, 7)).toBe('search');
    expect(shortcutAction({ key: ',', ctrlKey: true }, 7)).toBe('settings');
    expect(shortcutAction({ key: ',', metaKey: true }, 7)).toBe('settings');
    expect(shortcutAction({ key: 'r', ctrlKey: true }, 7)).toBeNull();
    expect(shortcutAction({ key: 'r', altKey: true }, 7)).toBeNull();
    expect(shortcutAction({ key: 'Escape', altKey: true }, 7)).toBe('escape');
  });

  it('uses physical keys with Korean IME output and ignores composing keys except Escape', () => {
    expect(shortcutAction({ key: 'ㄱ', code: 'KeyR' }, 9)).toBe('report');
    expect(shortcutAction({ key: 'ㄹ', code: 'KeyM' }, 9)).toBe('map');
    expect(shortcutAction({ key: 'ㅎ', code: 'KeyG' }, 9)).toBe('globe');
    expect(shortcutAction({ key: 'Process', code: 'KeyF', ctrlKey: true }, 9)).toBe('search');
    expect(shortcutAction({ key: 'ㄱ', code: 'Digit3' }, 9)).toEqual({ type: 'weapon', index: 2 });
    expect(shortcutAction({ key: 'ㄱ', code: 'Numpad9' }, 9)).toEqual({ type: 'weapon', index: 8 });
    expect(shortcutAction({ key: 'Process', code: 'NumpadEnter' }, 9)).toBe('chat');
    expect(shortcutAction({ key: 'Process', code: 'Escape' }, 9)).toBe('escape');
    expect(shortcutAction({ key: 'ㄱ', code: 'KeyR', isComposing: true }, 9)).toBeNull();
    expect(shortcutAction({ key: 'ㄱ', code: 'Escape', isComposing: true }, 9)).toBe('escape');
  });

  it('identifies editable controls while allowing non-DOM null targets', () => {
    expect(isEditableTarget(null)).toBe(false);
  });
});

describe('country and system search', () => {
  it('matches Korean, English, ISO code, system aliases and spacing', () => {
    expect(searchMatches('pol', countries, systems)[0]).toMatchObject({ kind: 'country', country: { id: 'POL' } });
    expect(searchMatches('Finland', countries, systems)[0]).toMatchObject({ kind: 'country', country: { id: 'FIN' } });
    expect(searchMatches('보병 전투 차량', countries, systems)[0]).toMatchObject({ kind: 'system', system: { id: 'ifv' } });
    expect(searchMatches('SPH', countries, systems)[0]).toMatchObject({ kind: 'system', system: { id: 'sph' } });
  });

  it('ranks combined country and system results before separate matches regardless of word order', () => {
    expect(searchMatches('폴란드 자주포', countries, systems)[0]).toMatchObject({ kind: 'combined', country: { id: 'POL' }, system: { id: 'sph' } });
    expect(searchMatches('자주포 폴란드', countries, systems)[0]).toMatchObject({ kind: 'combined', country: { id: 'POL' }, system: { id: 'sph' } });
  });
});
