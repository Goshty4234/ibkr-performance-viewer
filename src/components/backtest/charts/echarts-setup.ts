'use client';

type EChartsCore = typeof import('echarts/core');

export const CHART_COLORS = {
  text: '#8b9cb3',
  textStrong: '#f4f7fb',
  faint: '#5c6d85',
  grid: 'rgba(255,255,255,0.06)',
  axis: 'rgba(255,255,255,0.14)',
  tooltipBg: '#141c2b',
  tooltipBorder: 'rgba(255,255,255,0.12)',
  green: '#2dd4a8',
  red: '#ff6b7a',
  orange: '#ffb020',
  accent: '#4d8dff',
};

const THEME = {
  backgroundColor: 'transparent',
  textStyle: { color: CHART_COLORS.text, fontFamily: 'inherit' },
  color: ['#4d8dff', '#ffb020', '#4ade80', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635'],
  categoryAxis: {
    axisLine: { lineStyle: { color: CHART_COLORS.axis } },
    axisTick: { show: false },
    axisLabel: { color: CHART_COLORS.faint, fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisLabel: { color: CHART_COLORS.faint, fontSize: 11 },
    splitLine: { lineStyle: { color: CHART_COLORS.grid } },
  },
  logAxis: {
    axisLabel: { color: CHART_COLORS.faint, fontSize: 11 },
    splitLine: { lineStyle: { color: CHART_COLORS.grid } },
  },
  timeAxis: {
    axisLine: { lineStyle: { color: CHART_COLORS.axis } },
    axisLabel: { color: CHART_COLORS.faint, fontSize: 11 },
    splitLine: { show: false },
  },
  tooltip: {
    backgroundColor: CHART_COLORS.tooltipBg,
    borderColor: CHART_COLORS.tooltipBorder,
    textStyle: { color: CHART_COLORS.textStrong, fontSize: 12 },
  },
  legend: { textStyle: { color: CHART_COLORS.text } },
  dataZoom: {
    borderColor: 'transparent',
    fillerColor: 'rgba(77,141,255,0.12)',
    handleStyle: { color: '#4d8dff' },
    textStyle: { color: CHART_COLORS.faint },
    dataBackground: { lineStyle: { color: CHART_COLORS.faint }, areaStyle: { color: 'rgba(92,109,133,0.2)' } },
  },
};

/** Printable variant (report page). */
const LIGHT_THEME = {
  backgroundColor: 'transparent',
  textStyle: { color: '#334155', fontFamily: 'inherit' },
  color: ['#2563eb', '#d97706', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ea580c', '#65a30d'],
  categoryAxis: {
    axisLine: { lineStyle: { color: '#cbd5e1' } },
    axisTick: { show: false },
    axisLabel: { color: '#64748b', fontSize: 10 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisLabel: { color: '#64748b', fontSize: 10 },
    splitLine: { lineStyle: { color: '#e2e8f0' } },
  },
  legend: { textStyle: { color: '#334155' } },
  tooltip: { backgroundColor: '#fff', borderColor: '#cbd5e1', textStyle: { color: '#0f172a', fontSize: 12 } },
};

let loader: Promise<EChartsCore> | null = null;

/** ECharts is loaded once, on first chart mount, with only the modules we use. */
export function loadECharts(): Promise<EChartsCore> {
  loader ??= (async () => {
    const [core, charts, comps, renderers, features] = await Promise.all([
      import('echarts/core'),
      import('echarts/charts'),
      import('echarts/components'),
      import('echarts/renderers'),
      import('echarts/features'),
    ]);
    core.use([
      charts.LineChart,
      charts.BarChart,
      charts.PieChart,
      charts.HeatmapChart,
      charts.ScatterChart,
      charts.CandlestickChart,
      comps.GridComponent,
      comps.TooltipComponent,
      comps.LegendComponent,
      comps.DataZoomComponent,
      comps.VisualMapComponent,
      comps.MarkLineComponent,
      comps.MarkAreaComponent,
      comps.TitleComponent,
      comps.AxisPointerComponent,
      comps.BrushComponent,
      comps.ToolboxComponent,
      renderers.CanvasRenderer,
      features.LabelLayout,
    ]);
    core.registerTheme('bt-dark', THEME);
    core.registerTheme('bt-light', LIGHT_THEME);
    return core;
  })();
  return loader;
}
