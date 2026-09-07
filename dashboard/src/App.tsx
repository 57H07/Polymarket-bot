import { useState } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import {
  Header,
  BalanceCards,
  PnLPanel,
  TrendIndicators,
  StrategyGrid,
  OnChainStats,
  ActivityLog,
  ConfigPanel,
  ConnectionStatus,
  DipArbPanel,
  ArbitragePanel,
  SmartMoneyPanel,
  QuickStats,
  SessionSummary,
  HistoryPage,
  PositionsPage,
  StrategyControls,
  AmbientBackground,
} from './components';

type Page = 'dashboard' | 'history' | 'positions';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const { state, config, logs, connected, error, sendCommand } = useWebSocket();
  const isDryRun = config?.dryRun ?? true;

  const handleClosePosition = (tokenId: string, size: number) => {
    sendCommand('closePosition', { tokenId, size });
  };

  const handleToggleStrategy = (strategy: string, enabled: boolean) => {
    sendCommand('toggleStrategy', { strategy, enabled });
  };

  const handleRedeemPosition = (conditionId: string) => {
    sendCommand('redeemPosition', { conditionId });
  };

  const handleToggleDryRun = () => {
    if (!isDryRun) {
      // Safety check when switching to DRY RUN? No, usually switching TO live needs check.
      // Switching TO Live:
      const confirm = window.confirm('⚠️ WARNING: You are switching to LIVE trading mode.\n\nReal funds will be used. Ensure you have loaded your Private Key and understand the risks.\n\nContinue?');
      if (!confirm) return;
    }
    // payload.enabled = desired value of dryRun on the bot side
    sendCommand('toggleDryRun', { enabled: !isDryRun });
  };

  // History page
  if (currentPage === 'history') {
    return <HistoryPage onBack={() => setCurrentPage('dashboard')} />;
  }

  // Positions page
  if (currentPage === 'positions') {
    return (
      <PositionsPage
        onBack={() => setCurrentPage('dashboard')}
        state={state}
        onClosePosition={handleClosePosition}
        onRedeemPosition={handleRedeemPosition}
      />
    );
  }

  // Main dashboard — trading-focused layout on the design-canvas surface
  return (
    <div
      className={`relative min-h-screen overflow-hidden bg-poly-dark pb-14 text-white ${isDryRun ? 'dry-run-breathing' : 'live-mode-breathing'}`}
    >
      <AmbientBackground accent={isDryRun ? '#9b8cff' : '#34e0b0'} />

      <div className="app-shell mx-auto max-w-[1760px]">
        {/* Mode banner */}
        <div className="px-[clamp(14px,2.4vw,40px)] pt-3">
          <div
            className="flex items-center justify-center gap-2.5 rounded-control border px-4 py-1.5 font-mono text-[11px] tracking-[0.14em]"
            style={
              isDryRun
                ? { background: 'rgba(155,140,255,0.07)', borderColor: 'rgba(155,140,255,0.24)', color: '#b8aaff' }
                : { background: 'rgba(52,224,176,0.07)', borderColor: 'rgba(52,224,176,0.24)', color: '#34e0b0' }
            }
          >
            <span
              className="h-1.5 w-1.5 rounded-full animate-dot"
              style={{ background: isDryRun ? '#9b8cff' : '#34e0b0' }}
            />
            {isDryRun ? 'DRY RUN — NO REAL TRADES' : 'LIVE — REAL MONEY TRADING'}
          </div>
        </div>

        {/* Connection Status */}
        <ConnectionStatus connected={connected} error={error} />

        {/* Header */}
        <Header
          state={state}
          config={config}
          connected={connected}
          onHistoryClick={() => setCurrentPage('history')}
          onPositionsClick={() => setCurrentPage('positions')}
          onToggleDryRun={handleToggleDryRun}
          onResetPaper={() => { if (window.confirm('Reset the paper account, positions and simulation risk counters?')) sendCommand('resetPaper', {}); }}
        />

        <main className="space-y-4 px-[clamp(14px,2.4vw,40px)]">
          {/* KPI strip */}
          <QuickStats state={state} config={config} />

          {/* Balances */}
          <BalanceCards state={state} />

          {/* Strategy monitors */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <DipArbPanel state={state} />
            <ArbitragePanel state={state} />
            <PnLPanel state={state} config={config} />
            <SessionSummary state={state} />
          </div>

          {/* Smart money + control column */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2">
              <SmartMoneyPanel state={state} />
            </div>
            <div className="space-y-4">
              <StrategyControls config={config} onToggle={handleToggleStrategy} />
              <TrendIndicators state={state} />
              <StrategyGrid state={state} config={config} />
              <OnChainStats state={state} config={config} />
            </div>
          </div>

          {/* Live feed */}
          <ActivityLog logs={logs} />

          {/* Config — collapsible */}
          <details className="group">
            <summary className="flex cursor-pointer items-center gap-2 py-2 font-mono text-[11px] tracking-[0.12em] text-gray-500 transition-colors hover:text-gray-300">
              <span className="transition-transform group-open:rotate-90">▶</span>
              ADVANCED CONFIGURATION
            </summary>
            <div className="mt-2">
              <ConfigPanel config={config} />
            </div>
          </details>
        </main>

        {/* Footer */}
        <footer className="mt-7 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 px-4 font-mono text-[10.5px] tracking-[0.06em] text-gray-600">
          <span>{isDryRun ? 'DRY RUN — NO REAL TRADES' : 'LIVE TRADING'}</span>
          <span>·</span>
          <span>CONFIG · bot-config.ts</span>
          <span>·</span>
          <span>POLYGON</span>
          <span>·</span>
          <span className={connected ? 'text-green-400' : 'text-red-400'}>
            {connected ? 'CONNECTED' : 'DISCONNECTED'}
          </span>
          <span>·</span>
          <span>
            BUILT BY{' '}
            <a
              href="https://github.com/57H07/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-400 transition-colors hover:text-purple-300"
            >
              @57H07
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;
