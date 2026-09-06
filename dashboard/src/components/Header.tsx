import { useEffect, useState } from 'react';
import type { BotState, BotConfig } from '../types';
import { NetworkStatus } from './NetworkStatus';

interface HeaderProps {
  state: BotState | null;
  config: BotConfig | null;
  connected: boolean;
  onHistoryClick?: () => void;
  onPositionsClick?: () => void;
  onToggleDryRun?: () => void;
  onResetPaper?: () => void;
}

export function Header({ state, config, connected, onHistoryClick, onPositionsClick, onToggleDryRun, onResetPaper }: HeaderProps) {
  const [runtime, setRuntime] = useState('0m');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!state?.startTime) return;

    const updateRuntime = () => {
      const diff = Date.now() - state.startTime;
      const hours = Math.floor(diff / 3600000);
      const minutes = Math.floor((diff % 3600000) / 60000);
      const seconds = Math.floor((diff % 60000) / 1000);

      if (hours > 0) {
        setRuntime(`${hours}h ${minutes}m`);
      } else if (minutes > 0) {
        setRuntime(`${minutes}m ${seconds.toString().padStart(2, '0')}s`);
      } else {
        setRuntime(`${seconds}s`);
      }
    };

    updateRuntime();
    const interval = setInterval(updateRuntime, 1000);
    return () => clearInterval(interval);
  }, [state?.startTime]);

  const isPaused = state?.isPaused ?? false;
  const isDryRun = config?.dryRun ?? true;

  // Mock wallet address (in real app, this would come from config/state)
  const walletAddress = '0xaF98e0638671abD5140Ad981Ff4c01869F3410de';
  const shortWallet = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;

  const copyWallet = async () => {
    await navigator.clipboard.writeText(walletAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const signalCount = state?.dipArb?.signals?.length ?? 0;
  const opportunityCount = state?.arbitrage?.opportunitiesFound ?? 0;

  const statusBadge = connected
    ? isPaused
      ? { className: 'badge-yellow', dot: '#ffc46b', label: 'PAUSED', pulse: false }
      : { className: 'badge-green', dot: '#34e0b0', label: 'RUNNING', pulse: true }
    : { className: 'badge-red', dot: '#ff6b7a', label: 'OFFLINE', pulse: false };

  return (
    <header className="dc-rise flex flex-wrap items-center gap-x-5 gap-y-3.5 px-[clamp(14px,2.4vw,40px)] pb-5 pt-[clamp(18px,2.4vw,30px)]">
      {/* Identity */}
      <div className="flex min-w-0 items-center gap-3.5">
        <div
          className="grid h-[46px] w-[46px] flex-none place-items-center rounded-[14px] border border-[#2a2440]"
          style={{
            background: 'linear-gradient(145deg, #1b1630, #0d0d16)',
            boxShadow: '0 8px 26px rgba(112,86,255,0.22)',
          }}
        >
          <div
            className="h-3.5 w-3.5 rounded"
            style={{ background: 'linear-gradient(140deg, #9b8cff, #34e0b0)' }}
          />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-[1.1] tracking-[-0.02em] text-white">
            Polymarket Bot
          </h1>
          <div className="mt-[3px] font-mono text-[11px] tracking-[0.08em] text-gray-500">
            v3.0 · PROFESSIONAL
          </div>
        </div>
      </div>

      {/* Run state */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`badge ${statusBadge.className}`}>
          <span
            className={`h-[7px] w-[7px] rounded-full ${statusBadge.pulse ? 'animate-dot' : ''}`}
            style={{ background: statusBadge.dot }}
          />
          {statusBadge.label}
        </span>

        <span className={`badge ${isDryRun ? 'badge-purple' : 'badge-green'}`}>
          {isDryRun ? 'SIMULATION' : 'LIVE'}
        </span>

        {/* Signal / opportunity counters */}
        {signalCount > 0 && (
          <span className="badge badge-neutral tooltip font-mono" data-tooltip="Recent DipArb signals">
            SIG {Math.min(signalCount, 99)}
          </span>
        )}
        {opportunityCount > 0 && (
          <span className="badge badge-neutral tooltip font-mono" data-tooltip="Arbitrage opportunities found">
            OPP {Math.min(opportunityCount, 99)}
          </span>
        )}
      </div>

      {/* Network telemetry */}
      <div className="hidden 2xl:block">
        <NetworkStatus connected={connected} />
      </div>

      {/* Runtime + wallet + actions */}
      <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
        <div className="pr-1.5 text-right">
          <div className="text-[10px] tracking-[0.14em] text-gray-500">RUNTIME</div>
          <div className="font-mono text-[15px] font-medium text-gray-300">{runtime}</div>
        </div>

        <button
          onClick={copyWallet}
          title="Copy wallet address"
          className="inline-flex items-center gap-2.5 rounded-control border border-[#1e1e2a] bg-[#0d0d15] px-3.5 py-2.5 font-mono text-xs text-gray-400 transition-colors hover:border-[#2b2b3c] hover:text-white"
        >
          <span
            className="h-[18px] w-[18px] rounded-full"
            style={{ background: 'linear-gradient(140deg, #9b8cff, #4b3ba8)' }}
          />
          {shortWallet}
          <span className="text-gray-500">{copied ? '✓' : '⧉'}</span>
        </button>

        <button onClick={onHistoryClick} className="btn btn-secondary">
          History
        </button>

        <button onClick={onPositionsClick} className="btn btn-secondary">
          Positions
        </button>

        {isDryRun && (
          <button
            onClick={onResetPaper}
            className="btn btn-secondary"
            title="Reset the paper account and simulation risk counters"
          >
            Reset sim
          </button>
        )}

        <button
          onClick={onToggleDryRun}
          className={`btn ${isDryRun ? 'btn-success' : 'btn-danger'}`}
          title={isDryRun ? 'Switch to live trading' : 'Switch back to simulation'}
        >
          Switch to {isDryRun ? 'LIVE' : 'SIMULATION'}
        </button>
      </div>
    </header>
  );
}
