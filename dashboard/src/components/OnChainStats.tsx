import type { BotConfig, BotState } from '../types';

interface OnChainStatsProps {
  state: BotState | null;
  config: BotConfig | null;
}

/**
 * Merges and redeems performed on Polygon.
 *
 * Splits and swaps used to sit here too, but nothing in the bot ever
 * incremented those two counters, in either mode — they were permanent zeros
 * dressed up as data. In simulation nothing touches the chain at all, so the
 * panel says that outright rather than showing an empty scoreboard.
 */
export function OnChainStats({ state, config }: OnChainStatsProps) {
  const merges = state?.merges ?? 0;
  const redeems = state?.redeems ?? 0;
  const total = merges + redeems;
  const simulated = config?.dryRun ?? true;

  const stats = [
    { label: 'Merges', value: merges, color: '#4aa8ff' },
    { label: 'Redeems', value: redeems, color: '#34e0b0' },
  ];

  return (
    <div className="panel dc-rise" style={{ animationDelay: '0.38s' }}>
      <div className="panel-header">
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-white">On-Chain Ops</h3>
        <span className="metric-value text-lg text-white">{simulated ? '--' : total}</span>
      </div>

      <div className="panel-body">
        {simulated ? (
          <div className="inset-tile px-3 py-4 text-center">
            <div className="text-xs text-gray-400">No on-chain operations in simulation</div>
            <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-600">
              paper broker · nothing settles on Polygon
            </div>
          </div>
        ) : (
          <>
            {/* Composition bar */}
            <div className="mb-3 flex h-2 overflow-hidden rounded-full bg-[#16161f]">
              {stats.map((stat) => (
                <div
                  key={stat.label}
                  className="h-full transition-all duration-500"
                  style={{
                    width: total > 0 ? `${(stat.value / total) * 100}%` : '50%',
                    background: total > 0 ? stat.color : '#1f1f2b',
                  }}
                />
              ))}
            </div>

            <div className="grid grid-cols-2 gap-1.5">
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
          </>
        )}
      </div>
    </div>
  );
}
