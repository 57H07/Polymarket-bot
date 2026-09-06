import type { BotState } from '../types';

interface SessionSummaryProps {
  state: BotState | null;
}

export function SessionSummary({ state }: SessionSummaryProps) {
  const totalPnL = state?.totalPnL ?? 0;

  // Wins and losses are counted from realised exits only. A position that is
  // still open has no outcome yet: counting it would turn every entry into
  // half a win, which is what this panel used to do.
  const wins = state?.wins ?? 0;
  const losses = state?.losses ?? 0;
  const closed = state?.closedTrades ?? 0;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;
  const avgProfit = closed > 0 ? totalPnL / closed : 0;

  const arbProfit = state?.arbProfit ?? 0;
  const smartMoneyTrades = state?.smartMoneyTrades ?? 0;
  const dipArbTrades = state?.dipArbTrades ?? 0;

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="section-header mb-0">
          Session Summary
        </h2>
      </div>

      <div className="panel-body">
        {/* Win/Loss Stats */}
        <div className="grid grid-cols-4 gap-2 mb-6">
          <div className="text-center">
            <div className="metric-value text-[clamp(17px,1.5vw,26px)] text-green-400 glow-text-green">
              {wins}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Wins</div>
          </div>
          <div className="text-center">
            <div className="metric-value text-[clamp(17px,1.5vw,26px)] text-red-400">
              {losses}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Losses</div>
          </div>
          <div className="text-center">
            <div className={`metric-value text-[clamp(17px,1.5vw,26px)] ${closed === 0 ? 'text-gray-500' : winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
              {closed > 0 ? `${winRate.toFixed(0)}%` : '--'}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Win Rate</div>
          </div>
          <div className="text-center">
            <div className={`metric-value text-[clamp(17px,1.5vw,26px)] ${closed === 0 ? 'text-gray-500' : avgProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {closed > 0 ? `$${avgProfit.toFixed(2)}` : '--'}
            </div>
            <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Avg/Trade</div>
          </div>
        </div>

        {/* Win Rate Bar */}
        <div className="mb-6">
          <div className="flex justify-between text-xs text-gray-500 mb-2">
            <span>{closed > 0 ? 'Win Rate Distribution' : 'No closed trades yet'}</span>
            <span>{wins}W - {losses}L</span>
          </div>
          <div className="h-3 rounded-full bg-[#16161f] overflow-hidden flex">
            <div 
              className="h-full progress-gradient-green transition-all duration-500"
              style={{ width: closed > 0 ? `${winRate}%` : '0%' }}
            />
            <div 
              className="h-full progress-gradient-red transition-all duration-500"
              style={{ width: closed > 0 ? `${100 - winRate}%` : '0%' }}
            />
          </div>
        </div>

        <div className="divider" />

        {/* Strategy Breakdown */}
        <div className="text-xs text-gray-500 uppercase tracking-wider mb-3">
          Profit by Strategy
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-blue-400" />
              <span className="text-gray-300">Arbitrage</span>
            </div>
            <span className={`font-mono font-medium ${arbProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {arbProfit >= 0 ? '+' : ''}{arbProfit.toFixed(2)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple-400" />
              <span className="text-gray-300">Smart Money</span>
            </div>
            <span className="font-mono text-gray-400">{smartMoneyTrades} trades</span>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400" />
              <span className="text-gray-300">DipArb</span>
            </div>
            <span className="font-mono text-gray-400">{dipArbTrades} trades</span>
          </div>
        </div>
      </div>
    </div>
  );
}
