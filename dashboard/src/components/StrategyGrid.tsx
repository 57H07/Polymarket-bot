import type { BotState, BotConfig } from '../types';

interface StrategyGridProps {
  state: BotState | null;
  config: BotConfig | null;
}

export function StrategyGrid({ state, config }: StrategyGridProps) {
  const strategies = [
    {
      name: 'Smart Money',
      enabled: config?.smartMoney?.enabled ?? false,
      trades: state?.smartMoneyTrades ?? 0,
      detail: `${state?.followedWallets?.length ?? 0} wallets`,
      color: '#9b8cff',
    },
    {
      name: 'Arbitrage',
      enabled: config?.arbitrage?.enabled ?? false,
      trades: state?.arbTrades ?? 0,
      detail: 'price gaps',
      color: '#4aa8ff',
    },
    {
      name: 'DipArb',
      enabled: config?.dipArb?.enabled ?? false,
      trades: state?.dipArbTrades ?? 0,
      detail: 'sum target',
      color: '#34e0b0',
    },
    {
      name: 'Direct',
      enabled: config?.directTrading?.enabled ?? false,
      trades: state?.directTrades ?? 0,
      detail: 'trend-based',
      color: '#ffc46b',
    },
  ];

  const activeCount = strategies.filter((s) => s.enabled).length;

  return (
    <div className="panel dc-rise" style={{ animationDelay: '0.34s' }}>
      <div className="panel-header">
        <h3 className="text-[15px] font-bold tracking-[-0.01em] text-white">Strategy Activity</h3>
        <span className="font-mono text-[10.5px] text-gray-500">{activeCount}/4 ACTIVE</span>
      </div>
      <div className="panel-body grid grid-cols-2 gap-2 xl:grid-cols-4">
        {strategies.map((s) => (
          <div
            key={s.name}
            className="rounded-[14px] border px-3 py-2.5"
            style={{
              background: s.enabled
                ? `linear-gradient(120deg, ${s.color}14, rgba(255,255,255,0.012))`
                : '#0b0b12',
              borderColor: s.enabled ? `${s.color}33` : '#1a1a25',
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className="truncate text-xs font-semibold"
                style={{ color: s.enabled ? '#e4e4f0' : '#9494ad' }}
              >
                {s.name}
              </span>
              <span
                className="h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: s.enabled ? s.color : '#2c2c3c' }}
              />
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-2">
              <span
                className="metric-value text-lg"
                style={{ color: s.enabled ? s.color : '#6f6f88' }}
              >
                {s.trades}
              </span>
              <span className="truncate font-mono text-[10px] text-gray-500">{s.detail}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
