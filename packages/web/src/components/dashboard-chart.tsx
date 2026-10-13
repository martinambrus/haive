'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type Row = Record<string, string | number | null>;
type Series = { key: string; label: string };

export interface DashboardChartProps {
  kind: 'line' | 'bar' | 'pie' | 'area';
  xKey: string;
  series: Series[];
  data: Row[];
}

// Recharts takes hex values, not Tailwind classes.
const COLORS = ['#818cf8', '#34d399', '#fbbf24', '#fb7185', '#7dd3fc', '#5eead4', '#a3a3a3'];
const CHROME = { grid: '#262626', axis: '#737373', tooltipBg: '#0a0a0a', tooltipBorder: '#404040' };
const axisProps = { stroke: CHROME.axis, fontSize: 11, tickLine: false } as const;
const tooltipStyle = {
  backgroundColor: CHROME.tooltipBg,
  border: `1px solid ${CHROME.tooltipBorder}`,
  fontSize: 12,
};
const legendStyle = { fontSize: 11, color: CHROME.axis };
const margin = { top: 8, right: 8, bottom: 0, left: 0 };

const colorAt = (i: number) => COLORS[i % COLORS.length]!;

export default function DashboardChart({ kind, xKey, series, data }: DashboardChartProps) {
  if (data.length === 0) {
    return <div className="h-[220px] text-sm text-neutral-500">No data.</div>;
  }
  if (kind === 'pie') {
    const value = series[0]!;
    return (
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={legendStyle} verticalAlign="bottom" />
          <Pie data={data} dataKey={value.key} nameKey={xKey} name={value.label} outerRadius={70}>
            {data.map((_, i) => (
              <Cell key={i} fill={colorAt(i)} stroke="none" />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }
  const grid = <CartesianGrid stroke={CHROME.grid} vertical={false} />;
  const xAxis = <XAxis dataKey={xKey} interval="preserveStartEnd" minTickGap={24} {...axisProps} />;
  const yAxis = <YAxis width={40} {...axisProps} />;
  const tooltip = <Tooltip contentStyle={tooltipStyle} />;
  const legend = <Legend wrapperStyle={legendStyle} />;
  return (
    <ResponsiveContainer width="100%" height={220}>
      {kind === 'bar' ? (
        <BarChart data={data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={colorAt(i)} />
          ))}
        </BarChart>
      ) : kind === 'area' ? (
        <AreaChart data={data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={colorAt(i)}
              fill={colorAt(i)}
              fillOpacity={0.2}
            />
          ))}
        </AreaChart>
      ) : (
        <LineChart data={data} margin={margin}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={colorAt(i)}
              strokeWidth={2}
              dot={false}
              connectNulls={false}
            />
          ))}
        </LineChart>
      )}
    </ResponsiveContainer>
  );
}
