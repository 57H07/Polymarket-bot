import type { ReactNode } from 'react';

export type KpiTone = 'accent' | 'gain' | 'loss' | 'warn' | 'info' | 'neutral';

const TONE_COLOR: Record<KpiTone, string> = {
  accent: '#9b8cff',
  gain: '#34e0b0',
  loss: '#ff6b7a',
  warn: '#ffc46b',
  info: '#4aa8ff',
  neutral: '#e4e4f0',
};

/** Dot/aura hue — `neutral` values still deserve a coloured accent dot. */
const TONE_DOT: Record<KpiTone, string> = {
  ...TONE_COLOR,
  neutral: '#9494ad',
};

interface KpiCardProps {
  label: string;
  value: ReactNode;
  /** Short delta, e.g. "+3.4%" or "8W · 5L". */
  delta?: string;
  /** Muted qualifier after the delta, e.g. "vs 24h". */
  sub?: string;
  /** Glyph shown before the delta. Defaults from the tone. */
  arrow?: string;
  tone?: KpiTone;
  /** Values for the inline sparkline. Needs at least 2 points to draw. */
  spark?: number[];
  /** Entrance stagger, in seconds. */
  delay?: number;
  /** Flash the card border when the underlying value changes. */
  highlight?: boolean;
  title?: string;
}

/** Smooth (mid-point cubic) path through the series, matching the canvas curve. */
function sparkPath(values: number[], w: number, h: number): string {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - ((v - min) / range) * (h * 0.82) - h * 0.09,
  ]);

  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const cx = ((px + x) / 2).toFixed(1);
    d += ` C${cx} ${py.toFixed(1)},${cx} ${y.toFixed(1)},${x.toFixed(1)} ${y.toFixed(1)}`;
  }
  return d;
}

/**
 * Hero metric tile from the design canvas: hairline top edge, corner aura,
 * oversized mono value, delta line and an animated sparkline.
 */
export function KpiCard({
  label,
  value,
  delta,
  sub,
  arrow,
  tone = 'neutral',
  spark,
  delay = 0,
  highlight = false,
  title,
}: KpiCardProps) {
  const color = TONE_COLOR[tone];
  const dot = TONE_DOT[tone];
  const glyph = arrow ?? (tone === 'loss' ? '▼' : tone === 'gain' ? '▲' : '◆');
  const delaySec = `${delay.toFixed(2)}s`;

  return (
    <div
      title={title}
      className="card-sheen glass-card glass-card-hover dc-rise relative overflow-hidden px-[18px] pt-[18px] pb-4"
      style={{
        borderRadius: '18px',
        background: 'linear-gradient(160deg, #101019 0%, #0b0b12 60%, #0a0a10 100%)',
        boxShadow: highlight
          ? `0 0 0 1px ${color}55, 0 12px 40px ${color}33`
          : undefined,
        animationDelay: delaySec,
      }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-10 -right-10 h-[130px] w-[130px] rounded-full blur-[6px]"
        style={{ background: `radial-gradient(circle, ${dot}22, transparent 68%)` }}
      />

      <div className="relative flex items-center justify-between gap-2.5">
        <div className="metric-label truncate">{label}</div>
        <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: dot }} />
      </div>

      <div
        className="metric-value relative mt-3 text-[clamp(20px,2.2vw,30px)] transition-colors duration-200"
        style={{ color }}
      >
        {value}
      </div>

      <div className="relative mt-3.5 flex items-end justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color }}>
          {delta && (
            <>
              <span className="text-[11px]">{glyph}</span>
              {delta}
            </>
          )}
          {sub && <span className="ml-0.5 font-normal text-gray-500">{sub}</span>}
        </div>

        {spark && spark.length > 1 && (
          <svg
            viewBox="0 0 90 26"
            preserveAspectRatio="none"
            className="h-6 w-[74px] flex-none overflow-visible"
            aria-hidden="true"
          >
            <path
              d={sparkPath(spark, 90, 26)}
              fill="none"
              stroke={color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              pathLength={1}
              strokeDasharray={1}
              style={{ animation: 'dcDraw 1.4s ease-out both', animationDelay: delaySec }}
            />
          </svg>
        )}
      </div>
    </div>
  );
}
