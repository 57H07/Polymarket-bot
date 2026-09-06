import type { BotState } from '../types';

interface TrendIndicatorsProps {
  state: BotState | null;
}

type Trend = 'up' | 'down' | 'neutral';

const TREND_STYLE: Record<Trend, { label: string; color: string }> = {
  up: { label: '▲ BULL', color: '#34e0b0' },
  down: { label: '▼ BEAR', color: '#ff6b7a' },
  neutral: { label: '→ FLAT', color: '#9a9ab2' },
};

export function TrendIndicators({ state }: TrendIndicatorsProps) {
  const trends: { coin: string; glyph: string; trend: Trend }[] = [
    { coin: 'BTC', glyph: '₿', trend: (state?.btcTrend ?? 'neutral') as Trend },
    { coin: 'ETH', glyph: 'Ξ', trend: (state?.ethTrend ?? 'neutral') as Trend },
    { coin: 'SOL', glyph: '◎', trend: (state?.solTrend ?? 'neutral') as Trend },
  ];

  return (
    <div className="panel dc-rise" style={{ animationDelay: '0.3s' }}>
      <div className="panel-header">
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-white">Market Trends</h3>
        <span className="font-mono text-[10.5px] text-gray-500">15m K-LINES</span>
      </div>
      <div className="panel-body grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(110px,1fr))]">
        {trends.map(({ coin, glyph, trend }) => {
          const style = TREND_STYLE[trend];
          return (
            <div key={coin} className="inset-tile px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-bold text-gray-300">{coin}</span>
                <span
                  className="text-[10px] font-bold tracking-[0.08em]"
                  style={{ color: style.color }}
                >
                  {style.label}
                </span>
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2">
                <span className="text-lg leading-none text-gray-400">{glyph}</span>
                <span
                  className="font-mono text-[11px] uppercase"
                  style={{ color: style.color }}
                >
                  {trend}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
