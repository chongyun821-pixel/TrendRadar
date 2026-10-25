import { describe, expect, it } from 'vitest';
import { seed } from '../shared/data';
import { countryName } from '../shared/country-name';

describe('countryName', () => {
  it('uses the loaded seed country name when available', () => {
    const [code, country] = Object.entries(seed.countries).find(([, c]) => Boolean(c.ko))!;
    expect(countryName(code, seed)).toBe(country.ko);
  });

  it('uses a static Korean name for a country outside the seed', () => {
    expect(countryName('FRA', { countries: {} } as typeof seed)).toBe('프랑스');
  });

  it('keeps unknown codes unchanged', () => {
    expect(countryName('ZZZ', { countries: {} } as typeof seed)).toBe('ZZZ');
  });
});
