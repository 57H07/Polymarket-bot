import type { BotState } from '../types';

interface OnChainStatsProps {
  state: BotState | null;
}

export function OnChainStats({ state }: OnChainStatsProps) {
  const splits = state?.splits ?? 0;
  const merges = state?.merges ?? 0;
  const redeems = state?.redeems ?? 0;
  const swaps = state?.swaps ?? 0;
  const total = splits + merges + redeems + swaps;

  const stats = [
    { label: 'Splits', value: splits, color: '#9b8cff' },
    { label: 'Merges', value: merges, color: '#4aa8ff' },
    { label: 'Redeems', value: redeems, color: '#34e0b0' },
    { label: 'Swaps', value: swaps, color: '#ffc46b' },
  ];

  return (
    <div className="panel dc-rise" style={{ animationDelay: '0.38s' }}>
      <div className="panel-header">
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-white">On-Chain Ops</h3>
        <span className="metric-value text-lg text-white">{total}</span>
      </div>

      <div className="panel-body">
        {/* Composition bar */}
        <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-[#16161f]">
          {stats.map((stat) => (
            <div
              key={stat.label}
              className="h-full transition-all duration-500"
              style={{
                width: total > 0 ? `${(stat.value / total) * 100}%` : '25%',
                background: total > 0 ? stat.color : '#1f1f2b',
              }}
            />
          ))}
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {stats.map((stat) => (
            <div key={stat.label} className="inset-tile px-2 py-2 text-center">
              <div className="metric-value text-sm" style={{ color: stat.color }}>
                {stat.value}
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-gray-500">
                {stat.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
