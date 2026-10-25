import { describe, expect, it } from 'vitest';
import { pointCountryFeatures, POINT_RADIUS_DEG } from '../src/point-countries';
import { countryCatalog } from '../shared/countries';

describe('pointCountryFeatures', () => {
  it('makes a dot only for catalog countries without a map shape', () => {
    const dots = pointCountryFeatures([{ id: 'MYS' }], [
      { id: 'MYS', ko: '말레이시아', en: 'Malaysia', lat: 4, lon: 102 },
      { id: 'SGP', ko: '싱가포르', en: 'Singapore', lat: 1.35, lon: 103.82 },
    ]);
    expect(dots.map(d => d.id)).toEqual(['SGP']);
    expect(dots[0].point).toBe(true);
    const ring = dots[0].p[0][0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lon, lat] of ring) expect(Math.hypot(lon - 103.82, lat - 1.35)).toBeCloseTo(POINT_RADIUS_DEG, 6);
  });
  it('covers Singapore and Bahrain from the real catalog', () => {
    const ids = pointCountryFeatures([], countryCatalog.filter(c => ['SGP', 'BHR'].includes(c.id))).map(d => d.id).sort();
    expect(ids).toEqual(['BHR', 'SGP']);
  });
});
