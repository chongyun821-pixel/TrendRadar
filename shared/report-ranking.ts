import type { Forecast, Seed, SystemKey } from './types';
import { SYSTEM_KEYS } from './types';

/** Only dated opportunities enter the fixed ranking. */
export function rankByWindow(forecasts: Forecast[], limit: number): Forecast[] {
  return forecasts.filter(f => f.status !== 'none' && f.window != null)
    .sort((a, b) => a.window![0] - b.window![0] || a.window![1] - b.window![1] || b.score - a.score
      || a.countryKo.localeCompare(b.countryKo, 'ko') || a.systemKo.localeCompare(b.systemKo, 'ko')).slice(0, limit);
}

export interface RevenueSlice { system: SystemKey; low: number; high: number; midpoint: number; count: number }
export interface AnnualRevenue { years: number[]; series: { system: SystemKey; amounts: number[] }[] }

const yearsInWindow = (forecast: Forecast) => forecast.window![1] - forecast.window![0] + 1;

/** Select the fixed TOP 5 overlapping the first three years, then allocate only the overlap. */
export function revenueMix(forecasts: Forecast[], data: Seed, asOfYear = data.meta.baseYear): { slices: RevenueSlice[]; unknown: number } {
  let unknown = 0;
  const slices = SYSTEM_KEYS.filter(system => data.systems[system]?.hanwha.length).map(system => {
    const top = rankByWindow(forecasts.filter(f => f.system === system && f.window && f.window[0] <= asOfYear + 2 && f.window[1] >= asOfYear), 5);
    const known = top.filter(f => f.krw);
    unknown += top.length - known.length;
    const share = (forecast: Forecast) => (Math.min(asOfYear + 2, forecast.window![1]) - Math.max(asOfYear, forecast.window![0]) + 1) / yearsInWindow(forecast);
    const low = known.reduce((sum, forecast) => sum + forecast.krw![0] * share(forecast), 0);
    const high = known.reduce((sum, forecast) => sum + forecast.krw![1] * share(forecast), 0);
    return { system, low, high, midpoint: (low + high) / 2, count: known.length };
  }).filter(slice => slice.midpoint > 0);
  return { slices, unknown };
}

/** Keep the same earliest TOP 5 for all 20 years, including years outside their windows as zero. */
export function annualRevenue(forecasts: Forecast[], data: Seed, asOfYear = data.meta.baseYear): AnnualRevenue {
  const years = Array.from({ length: 20 }, (_, index) => asOfYear + index);
  const series = SYSTEM_KEYS.filter(system => data.systems[system]?.hanwha.length).map(system => {
    const top = rankByWindow(forecasts.filter(f => f.system === system), 5).filter(f => f.window && f.krw);
    return { system, amounts: years.map(year => top.reduce((sum, forecast) => year < forecast.window![0] || year > forecast.window![1] ? sum : sum + (forecast.krw![0] + forecast.krw![1]) / 2 / yearsInWindow(forecast), 0)) };
  });
  return { years, series };
}
