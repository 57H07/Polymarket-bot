import { useState, useEffect } from 'react';
import type { SessionSummary, HistoryData } from '../types';
import { AmbientBackground } from './AmbientBackground';

interface HistoryPageProps {
  onBack: () => void;
}

export function HistoryPage({ onBack }: HistoryPageProps) {
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchHistory();
  }, []);

  const fetchHistory = async () => {
    try {
      setLoading(true);
      const response = await fetch('http://localhost:3001/api/history');
      if (!response.ok) throw new Error('Failed to fetch history');
      const data = await response.json();
      setHistory(data);
      setError(null);
    } catch (err) {
      setError('Failed to load history. Make sure the bot server is running.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const fetchSession = async (sessionId: string) => {
    try {
      const response = await fetch(`http://localhost:3001/api/history/${sessionId}`);
      if (!response.ok) throw new Error('Failed to fetch session');
      const data = await response.json();
      setSelectedSession(data);
    } catch (err) {
      console.error('Failed to fetch session details:', err);
    }
  };

  const formatDuration = (ms: number) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatPnL = (value: number) => {
    const formatted = Math.abs(value).toFixed(2);
    return value >= 0 ? `+$${formatted}` : `-$${formatted}`;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-poly-dark flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin w-12 h-12 border-4 border-poly-purple border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-gray-400">Loading history...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-poly-dark pb-14 text-white">
      <AmbientBackground />
      <div className="app-shell mx-auto max-w-[1760px]">
      {/* Header */}
      <header className="dc-rise px-[clamp(14px,2.4vw,40px)] py-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <button
              onClick={onBack}
              className="btn btn-secondary"
            >
              ← Back to Dashboard
            </button>
            <div className="flex items-center gap-3">
              <div
                className="grid h-10 w-10 flex-none place-items-center rounded-[12px] border border-[#2a2440]"
                style={{ background: 'linear-gradient(145deg, #1b1630, #0d0d16)' }}
              >
                <div className="h-3 w-3 rounded" style={{ background: 'linear-gradient(140deg, #9b8cff, #4aa8ff)' }} />
              </div>
              <div>
                <h1 className="text-xl font-bold">Session History</h1>
                <div className="mt-0.5 font-mono text-[11px] tracking-[0.08em] text-gray-500">VIEW PAST TRADING SESSIONS</div>
              </div>
            </div>
          </div>

          {/* Overall Stats */}
          {history && (
            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Total Sessions</div>
                <div className="text-xl font-bold font-mono">{history.totalSessions}</div>
              </div>
              <div className="w-px h-10 bg-white/10" />
              <div className="text-right">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Total Profit</div>
                <div className={`text-xl font-bold font-mono ${history.totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                  {formatPnL(history.totalProfit)}
                </div>
              </div>
              <div className="w-px h-10 bg-white/10" />
              <div className="text-right">
                <div className="text-xs text-gray-500 uppercase tracking-wider">Win Rate</div>
                <div className="text-xl font-bold font-mono text-purple-400">
                  {history.overallWinRate.toFixed(1)}%
                </div>
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="px-[clamp(14px,2.4vw,40px)]">
        {error ? (
          <div className="panel p-8 text-center">
            <div className="text-red-400">{error}</div>
            <button onClick={fetchHistory} className="btn btn-primary mt-4">
              Retry
            </button>
          </div>
        ) : history?.sessions.length === 0 ? (
          <div className="panel p-12 text-center">
            <div className="text-6xl mb-4">📭</div>
            <h2 className="text-xl font-semibold mb-2">No Sessions Yet</h2>
            <p className="text-gray-400">
              Run the bot and complete a trading session to see history here.
            </p>
          </div>
        ) : selectedSession ? (
          /* Session Detail View */
          <div className="space-y-6 animate-fade-in">
            <button
              onClick={() => setSelectedSession(null)}
              className="text-gray-400 hover:text-white transition-colors flex items-center gap-2"
            >
              ← Back to Sessions
            </button>

            {/* Session Header */}
            <div className="panel">
              <div className="panel-body">
                <div className="flex items-start justify-between mb-6">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`badge ${selectedSession.dryRun ? 'badge-blue' : 'badge-green'}`}>
                        {selectedSession.dryRun ? '🧪 Simulation' : '💰 Live'}
                      </span>
                      <span className="text-gray-500">
                        {formatDate(selectedSession.startTime)}
                      </span>
                    </div>
                    <h2 className="text-2xl font-bold">
                      Session from {formatTime(selectedSession.startTime)} to {formatTime(selectedSession.endTime)}
                    </h2>
                    <div className="text-gray-400 mt-1">
                      Duration: {formatDuration(selectedSession.durationMs)}
                    </div>
                  </div>
                  <div className={`text-4xl font-bold font-mono ${selectedSession.totalPnL >= 0 ? 'text-green-400 glow-text-green' : 'text-red-400'}`}>
                    {formatPnL(selectedSession.totalPnL)}
                  </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-white">{selectedSession.totalTrades}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Trades</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-green-400">{selectedSession.wins}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Wins</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-red-400">{selectedSession.losses}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Losses</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className={`text-2xl font-bold font-mono ${selectedSession.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                      {selectedSession.winRate.toFixed(1)}%
                    </div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Win Rate</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-green-400">{formatPnL(selectedSession.largestWin)}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Best Trade</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-red-400">{formatPnL(selectedSession.largestLoss)}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Worst Trade</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Strategy Breakdown */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="panel">
                <div className="panel-header">
                  <h3 className="section-header mb-0">
                    Strategy Performance
                  </h3>
                </div>
                <div className="panel-body space-y-3">
                  {[
                    { name: 'Smart Money', key: 'smartMoney', color: 'purple', enabled: selectedSession.strategies.smartMoney },
                    { name: 'Arbitrage', key: 'arbitrage', color: 'blue', enabled: selectedSession.strategies.arbitrage },
                    { name: 'DipArb', key: 'dipArb', color: 'green', enabled: selectedSession.strategies.dipArb },
                    { name: 'Direct Trading', key: 'direct', color: 'yellow', enabled: selectedSession.strategies.direct },
                  ].map((strategy) => {
                    const stats = selectedSession.strategyStats[strategy.key as keyof typeof selectedSession.strategyStats];
                    return (
                      <div key={strategy.key} className={`flex items-center justify-between p-3 inset-tile ${!strategy.enabled ? 'opacity-50' : ''}`}>
                        <div className="flex items-center gap-3">
                          <div className={`w-3 h-3 rounded-full bg-${strategy.color}-400`} />
                          <span className="text-white">{strategy.name}</span>
                          {!strategy.enabled && <span className="badge bg-gray-500/20 text-gray-500 text-xs">OFF</span>}
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-gray-400">{stats.trades} trades</span>
                          <span className={`font-mono font-semibold ${stats.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnL(stats.profit)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Wallet Performance */}
              <div className="panel">
                <div className="panel-header">
                  <h3 className="section-header mb-0">
                    Copied Wallets Performance
                  </h3>
                </div>
                <div className="panel-body">
                  {selectedSession.walletPerformance.length === 0 ? (
                    <div className="text-center text-gray-500 py-6">
                      No wallet copy trades in this session
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {selectedSession.walletPerformance.map((wallet) => (
                        <div key={wallet.wallet} className="flex items-center justify-between p-3 inset-tile">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-400 to-pink-400" />
                            <div>
                              <code className="text-sm text-gray-300">{wallet.wallet.slice(0, 8)}...{wallet.wallet.slice(-6)}</code>
                              <div className="text-xs text-gray-500">{wallet.trades} trades • {wallet.winRate.toFixed(0)}% win</div>
                            </div>
                          </div>
                          <span className={`font-mono font-semibold ${wallet.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnL(wallet.profit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* On-Chain Operations */}
            <div className="panel">
              <div className="panel-header">
                <h3 className="section-header mb-0">
                  On-Chain Operations
                </h3>
              </div>
              <div className="panel-body">
                <div className="grid grid-cols-4 gap-4">
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-purple-400">{selectedSession.onChainOps.splits}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Splits</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-blue-400">{selectedSession.onChainOps.merges}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Merges</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-green-400">{selectedSession.onChainOps.redeems}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Redeems</div>
                  </div>
                  <div className="inset-tile p-4 text-center">
                    <div className="text-2xl font-bold font-mono text-yellow-400">{selectedSession.onChainOps.swaps}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider mt-1">Swaps</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Trade List */}
            {selectedSession.trades.length > 0 && (
              <div className="panel">
                <div className="panel-header">
                  <h3 className="section-header mb-0">
                    Trade History
                  </h3>
                </div>
                <div className="panel-body">
                  <div className="space-y-2 max-h-96 overflow-y-auto">
                    {selectedSession.trades.map((trade) => (
                      <div key={trade.id} className="flex items-center justify-between p-3 inset-tile border border-white/5">
                        <div className="flex items-center gap-4">
                          <span className="text-xs text-gray-500 font-mono w-16">
                            {formatTime(trade.timestamp)}
                          </span>
                          <span className={`badge ${trade.side === 'BUY' ? 'badge-green' : 'badge-red'}`}>
                            {trade.side}
                          </span>
                          <span className="badge badge-purple text-xs">{trade.strategy}</span>
                          <span className="text-gray-300 truncate max-w-[200px]" title={trade.market}>
                            {trade.market}
                          </span>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-gray-400">${trade.size.toFixed(2)} @ {trade.price.toFixed(3)}</span>
                          <span className={`font-mono font-semibold ${trade.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {formatPnL(trade.profit)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Sessions List View */
          <div className="space-y-4 animate-fade-in">
            {history?.sessions.map((session) => (
              <div
                key={session.id}
                onClick={() => fetchSession(session.id)}
                className="panel glass-card-hover cursor-pointer"
              >
                <div className="panel-body">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      {/* Date/Time */}
                      <div className="text-center min-w-[80px]">
                        <div className="text-2xl font-bold text-white">
                          {new Date(session.startTime).getDate()}
                        </div>
                        <div className="text-xs text-gray-500 uppercase">
                          {new Date(session.startTime).toLocaleDateString('en-US', { month: 'short' })}
                        </div>
                      </div>

                      <div className="w-px h-12 bg-white/10" />

                      {/* Session Info */}
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`badge ${session.dryRun ? 'badge-blue' : 'badge-green'}`}>
                            {session.dryRun ? '🧪 Simulation' : '💰 Live'}
                          </span>
                          <span className="text-gray-500 text-sm">
                            {formatTime(session.startTime)} - {formatTime(session.endTime)}
                          </span>
                        </div>
                        <div className="text-sm text-gray-400">
                          Duration: {formatDuration(session.durationMs)} • {session.totalTrades} trades
                        </div>
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center gap-6">
                      <div className="text-center">
                        <div className="text-lg font-mono font-bold text-green-400">{session.wins}</div>
                        <div className="text-xs text-gray-500">Wins</div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-mono font-bold text-red-400">{session.losses}</div>
                        <div className="text-xs text-gray-500">Losses</div>
                      </div>
                      <div className="text-center">
                        <div className={`text-lg font-mono font-bold ${session.winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                          {session.winRate.toFixed(0)}%
                        </div>
                        <div className="text-xs text-gray-500">Win Rate</div>
                      </div>
                      <div className="w-px h-12 bg-white/10" />
                      <div className="text-right min-w-[100px]">
                        <div className={`text-2xl font-mono font-bold ${session.totalPnL >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {formatPnL(session.totalPnL)}
                        </div>
                        <div className="text-xs text-gray-500">P&L</div>
                      </div>
                      <div className="text-gray-500">→</div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
