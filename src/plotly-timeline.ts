import { allForecasts, fmtKrw } from '../shared/forecast';
import type { Seed } from '../shared/types';
import { annualRevenue } from './ranking-report';
import { SYSTEM_COLOR } from './map-style';

type Range = [number, number] | null;
type PlotlyApi = (typeof import('plotly.js-basic-dist-min'))['default'];
type PlotNode = HTMLElement & { on: (event: string, callback: (detail: Record<string, unknown>) => void) => void };

let plotlyPromise: Promise<PlotlyApi> | null = null;
let loadedPlotly: PlotlyApi | null = null;
const loadPlotly = () => plotlyPromise ??= import('plotly.js-basic-dist-min').then(module => (loadedPlotly = module.default));

const scaleMaximum = (value: number) => Math.max(1, value * 1.05);

export function purgeTimeline(node: HTMLElement | null) {
  if (node && loadedPlotly && node.classList.contains('js-plotly-plot')) loadedPlotly.purge(node);
}

export async function mountTimeline(node: HTMLElement, data: Seed, selected: Range, onRange: (range: Range) => void) {
  const { years, series } = annualRevenue(allForecasts(null, data), data);
  if (!years.length || !series.some(line => line.amounts.some(amount => amount > 0))) {
    node.textContent = '연도별 금액을 산출할 자료가 없습니다.';
    return;
  }
  const Plotly = await loadPlotly();
  if (!node.isConnected || node.closest('[hidden]')) return;
  const full: [number, number] = [years[0], years.at(-1)!];
  const clamped: Range = selected ? [Math.max(full[0] - .5, selected[0]), Math.min(full[1] + .5, selected[1])] : null;
  const range: Range = clamped && clamped[0] < clamped[1] ? clamped : null;
  const peak = scaleMaximum(Math.max(...series.flatMap(line => line.amounts)));
  const ticks = [0, 1, 2, 3, 4].map(i => peak * i / 4);
  const traces = series.map(line => ({
    type: 'scatter', mode: 'lines', name: data.systems[line.system].ko,
    x: years, y: line.amounts, customdata: line.amounts.map(amount => `${fmtKrw(amount)} 원`),
    line: { color: SYSTEM_COLOR[line.system], width: 3.5, shape: 'spline', smoothing: 0.55 },
    hovertemplate: '%{fullData.name}: %{customdata}<extra></extra>',
  }));
  const layout: Record<string, unknown> = {
    paper_bgcolor: '#101a29', plot_bgcolor: '#101a29',
    font: { color: '#b6c7dd', family: 'Pretendard, Malgun Gothic, sans-serif', size: 12 },
    margin: { l: 72, r: 20, t: 84, b: 70 },
    height: 520, autosize: true,
    hovermode: 'x unified', dragmode: 'zoom',
    uirevision: 'ranking-timeline',
    xaxis: {
      title: { text: '연도', font: { size: 11 } }, type: 'linear', tickformat: 'd', nticks: 9,
      range: range ?? [full[0] - .5, full[1] + .5], minallowed: full[0] - .5, maxallowed: full[1] + .5,
      gridcolor: '#27364b', zeroline: false,
      rangeslider: { visible: true, bgcolor: '#18263b', bordercolor: '#405574', thickness: 0.13 },
    },
    yaxis: {
      title: { text: '예상 수주액', font: { size: 11 } }, range: [0, peak],
      tickvals: ticks, ticktext: ticks.map(value => fmtKrw(value)),
      gridcolor: '#34425a', zeroline: false, fixedrange: true,
    },
    legend: { orientation: 'h', x: 0, font: { size: 11 } },
  };
  const config: Record<string, unknown> = {
    responsive: true, scrollZoom: true, displayModeBar: true, displaylogo: false, showTips: false,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    toImageButtonOptions: { format: 'png', filename: `trendradar-${data.meta.baseYear}-annual-opportunities`, scale: 2 },
  };
  const alreadyMounted = node.classList.contains('js-plotly-plot');
  await (alreadyMounted ? Plotly.react(node, traces, layout, config) : Plotly.newPlot(node, traces, layout, config));
  if (!node.isConnected || node.closest('[hidden]')) return;
  if (!node.dataset.timelineEventsBound) {
    (node as PlotNode).on('plotly_relayout', event => {
      const axisRange = event['xaxis.range'];
      const start = Number(Array.isArray(axisRange) ? axisRange[0] : event['xaxis.range[0]']);
      const end = Number(Array.isArray(axisRange) ? axisRange[1] : event['xaxis.range[1]']);
      const reset = event['xaxis.autorange'] === true || (start <= full[0] - .5 && end >= full[1] + .5);
      if (reset) onRange(null);
      else if (Number.isFinite(start) && Number.isFinite(end)) onRange([start, end]);
      else return;
      const selectedRange = reset ? full : [start, end];
      const visible = series.flatMap(line => line.amounts.filter((_, i) => years[i] >= selectedRange[0] && years[i] <= selectedRange[1]));
      const ceiling = scaleMaximum(Math.max(0, ...visible));
      const yTicks = [0, 1, 2, 3, 4].map(i => ceiling * i / 4);
      void Plotly.relayout(node, { 'yaxis.range': [0, ceiling], 'yaxis.tickvals': yTicks, 'yaxis.ticktext': yTicks.map(value => fmtKrw(value)) });
    });
    node.dataset.timelineEventsBound = 'true';
  }
}
