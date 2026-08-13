import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { formatLKR, formatCompact } from '../lib/currency';

/* ------------------------------------------------------------------------ */
/* Shared helpers                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Renders the SVG at the container's true pixel width rather than scaling a
 * fixed viewBox, so stroke widths stay at their specified thickness.
 */
const useElementWidth = <T extends HTMLElement>() => {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => setWidth(element.clientWidth);
    update();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
};

/** Rounds an axis maximum up to a clean 1/2/5 x 10^n value. */
const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
};

const SURFACE = 'var(--surface-variant)';

/* ------------------------------------------------------------------------ */
/* Trend chart — one series, so no legend: the title names it                */
/* ------------------------------------------------------------------------ */

export interface TrendPoint {
  date: string;   // ISO yyyy-mm-dd
  value: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  height?: number;
  color?: string;
}

export const TrendChart: React.FC<TrendChartProps> = ({
  data,
  height = 168,
  color = 'var(--primary-light)',
}) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const padding = { top: 14, right: 12, bottom: 22, left: 44 };
  const plotWidth = Math.max(width - padding.left - padding.right, 10);
  const plotHeight = height - padding.top - padding.bottom;

  const values = data.map((d) => d.value);
  const rawMax = Math.max(...values, 0);
  const max = niceMax(rawMax);
  const ticks = [0, max / 2, max];

  const xAt = (i: number) =>
    padding.left + (data.length <= 1 ? plotWidth / 2 : (i / (data.length - 1)) * plotWidth);
  const yAt = (v: number) => padding.top + plotHeight - (max === 0 ? 0 : (v / max) * plotHeight);

  const handlePointer = useCallback(
    (clientX: number, target: SVGSVGElement) => {
      const box = target.getBoundingClientRect();
      const x = clientX - box.left - padding.left;
      const ratio = plotWidth === 0 ? 0 : x / plotWidth;
      const index = Math.round(ratio * (data.length - 1));
      setHoverIndex(Math.max(0, Math.min(data.length - 1, index)));
    },
    [data.length, plotWidth, padding.left]
  );

  if (data.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 'var(--sp-6)' }}>
        <p className="empty-text">No spending recorded in this period.</p>
      </div>
    );
  }

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(d.value)}`).join(' ');
  const areaPath =
    `${linePath} L${xAt(data.length - 1)},${padding.top + plotHeight} L${xAt(0)},${padding.top + plotHeight} Z`;

  // Label the extreme only — a number on every point is unreadable.
  const peakIndex = values.indexOf(Math.max(...values));
  const active = hoverIndex ?? null;
  const activePoint = active !== null ? data[active] : null;

  // Roughly four x labels, always including the last day. Anything within half
  // a step of the end is dropped, otherwise it collides with the final label.
  const labelStep = Math.max(1, Math.floor(data.length / 4));
  const lastIndex = data.length - 1;
  const showLabel = (i: number) =>
    i === lastIndex || (i % labelStep === 0 && lastIndex - i > labelStep / 2);

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }}>
      {width > 0 && (
        <svg
          className="chart"
          width={width}
          height={height}
          role="img"
          aria-label={`Daily spending trend over ${data.length} days`}
          onMouseMove={(e) => handlePointer(e.clientX, e.currentTarget)}
          onMouseLeave={() => setHoverIndex(null)}
          onTouchStart={(e) => handlePointer(e.touches[0].clientX, e.currentTarget)}
          onTouchMove={(e) => handlePointer(e.touches[0].clientX, e.currentTarget)}
          onTouchEnd={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="trendWash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.22" />
              <stop offset="100%" stopColor={color} stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* Solid hairline grid, one step off the surface */}
          {ticks.map((t) => (
            <g key={t}>
              <line
                className="chart-grid-line"
                x1={padding.left}
                x2={width - padding.right}
                y1={yAt(t)}
                y2={yAt(t)}
              />
              <text className="chart-axis-label" x={padding.left - 8} y={yAt(t) + 3} textAnchor="end">
                {formatCompact(t)}
              </text>
            </g>
          ))}

          <path d={areaPath} fill="url(#trendWash)" />
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Peak marker: r>=4 with a 2px surface ring so it stays legible */}
          {rawMax > 0 && (
            <circle cx={xAt(peakIndex)} cy={yAt(values[peakIndex])} r={4} fill={color} stroke={SURFACE} strokeWidth={2} />
          )}

          {data.map((d, i) =>
            showLabel(i) ? (
              <text
                key={d.date}
                className="chart-axis-label"
                x={xAt(i)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === lastIndex ? 'end' : 'middle'}
              >
                {new Date(d.date + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
              </text>
            ) : null
          )}

          {/* Hover crosshair */}
          {active !== null && (
            <g>
              <line
                x1={xAt(active)}
                x2={xAt(active)}
                y1={padding.top}
                y2={padding.top + plotHeight}
                stroke="var(--on-surface-faint)"
                strokeWidth={1}
              />
              <circle
                cx={xAt(active)}
                cy={yAt(data[active].value)}
                r={5}
                fill={color}
                stroke={SURFACE}
                strokeWidth={2}
              />
            </g>
          )}
        </svg>
      )}

      {activePoint && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: Math.min(Math.max(xAt(hoverIndex!) - 60, 0), Math.max(width - 124, 0)),
            width: 124,
            background: 'var(--surface-elevated)',
            border: '1px solid var(--card-border)',
            borderRadius: 'var(--r-sm)',
            padding: '6px 10px',
            pointerEvents: 'none',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          <div style={{ fontSize: '0.7rem', color: 'var(--on-surface-variant)' }}>
            {new Date(activePoint.date + 'T00:00:00').toLocaleDateString(undefined, {
              day: 'numeric',
              month: 'short',
            })}
          </div>
          <div className="tabular" style={{ fontSize: '0.85rem', fontWeight: 700 }}>
            {formatLKR(activePoint.value)}
          </div>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------------ */
/* Ranked category bars                                                      */
/* ------------------------------------------------------------------------ */

export interface CategoryDatum {
  key: string;
  label: string;
  emoji: string;
  value: number;
  color: string;
}

/**
 * Horizontal ranked bars. Each row is directly labelled, so identity never
 * depends on colour alone.
 */
export const CategoryBars: React.FC<{ data: CategoryDatum[]; total: number }> = ({ data, total }) => {
  if (data.length === 0) {
    return (
      <div className="empty-state" style={{ padding: 'var(--sp-6)' }}>
        <p className="empty-text">Nothing to break down yet.</p>
      </div>
    );
  }

  const max = Math.max(...data.map((d) => d.value), 0);

  return (
    <div className="stack">
      {data.map((d) => {
        const share = total > 0 ? (d.value / total) * 100 : 0;
        return (
          <div key={d.key} className="card" style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
            <div className="row-between" style={{ marginBottom: 8 }}>
              <span className="row" style={{ gap: 8, minWidth: 0 }}>
                <span aria-hidden="true">{d.emoji}</span>
                <span className="truncate" style={{ fontWeight: 600, fontSize: '0.9rem' }}>
                  {d.label}
                </span>
              </span>
              <span className="row" style={{ gap: 10, flexShrink: 0 }}>
                <span className="hint tabular">{share.toFixed(1)}%</span>
                <span className="amount-md tabular">{formatLKR(d.value)}</span>
              </span>
            </div>
            {/* Bar caps at 8px: thin marks, 4px rounded data-end */}
            <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-variant)', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${max > 0 ? (d.value / max) * 100 : 0}%`,
                  height: '100%',
                  background: d.color,
                  borderRadius: '0 4px 4px 0',
                  transition: 'width var(--dur) var(--ease)',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};

/* Re-exported so pages can render a legend when they need one. */
export const Legend: React.FC<{ items: { label: string; color: string }[] }> = ({ items }) => (
  <div className="legend">
    {items.map((i) => (
      <span key={i.label} className="legend-item">
        <span className="legend-swatch" style={{ background: i.color }} />
        {i.label}
      </span>
    ))}
  </div>
);

/* ------------------------------------------------------------------ Donut */

export interface PieDatum {
  label: string;
  value: number;
  color: string;
}

/**
 * Donut rather than a full pie: the hole carries the total, which is the number
 * people look for first, and the arc lengths still read as fractions.
 *
 * Drawn with stroke-dasharray on circles instead of arc paths — no trig, no
 * large-arc-flag edge case at exactly half, and a single-slice chart renders as
 * a clean ring instead of a degenerate path.
 */
export const DonutChart: React.FC<{
  data: PieDatum[];
  total: number;
  size?: number;
  centerLabel?: string;
}> = ({ data, total, size = 168, centerLabel }) => {
  const stroke = Math.round(size * 0.16);
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total <= 0) {
    return (
      <svg width={size} height={size} role="img" aria-label="Nothing to show yet">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--card-border)"
          strokeWidth={stroke}
        />
      </svg>
    );
  }

  let offset = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={data.map((d) => `${d.label} ${Math.round((d.value / total) * 100)}%`).join(', ')}
    >
      <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
        {data.map((slice) => {
          const fraction = slice.value / total;
          const length = fraction * circumference;
          const dash = `${length} ${circumference - length}`;
          const el = (
            <circle
              key={slice.label}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth={stroke}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
            />
          );
          offset += length;
          return el;
        })}
      </g>

      {centerLabel && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fontSize: size * 0.13, fontWeight: 800, fill: 'var(--on-surface)' }}
        >
          {centerLabel}
        </text>
      )}
    </svg>
  );
};
