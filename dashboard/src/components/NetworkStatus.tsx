import { useEffect, useState } from 'react';
import type { BotState } from '../types';

interface NetworkStatusProps {
  connected: boolean;
  state: BotState | null;
}

/**
 * Polygon telemetry, read from the bot's read-only RPC poll.
 *
 * Every value here used to be `Math.random()` on a 5s timer — a gas price, a
 * block height and a latency that never touched the chain. Anything the bot
 * cannot actually measure now renders as "--" instead.
 */
export function NetworkStatus({ connected, state }: NetworkStatusProps) {
  const chain = state?.chain;
  const [age, setAge] = useState<number | null>(null);

  // Freshness of the last chain read, recomputed locally every second.
  useEffect(() => {
    const tick = () => setAge(chain?.updatedAt ? Date.now() - chain.updatedAt : null);
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [chain?.updatedAt]);

  const gasColor = (gas: number) => {
    if (gas < 30) return 'text-green-400';
    if (gas < 50) return 'text-yellow-400';
    return 'text-red-400';
  };

  // The poll runs every 30s; past a minute without an update something is wrong.
  const stale = age !== null && age > 60_000;
  const ageLabel = age === null ? '--' : age < 60_000 ? `${Math.floor(age / 1000)}s` : `${Math.floor(age / 60_000)}m`;

  return (
    <div className="inline-flex items-center gap-3.5 rounded-control border border-[#1e1e2a] bg-white/[0.03] px-3.5 py-2 font-mono text-[11px]">
      {/* Age of the last successful chain read */}
      <span className="flex items-center gap-2" title="Time since the last Polygon RPC read">
        <span className="spinner-ring" />
        <span className={stale ? 'text-yellow-400' : 'text-gray-400'}>{ageLabel}</span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Gas price */}
      <span className="flex items-center gap-1.5" title="Polygon gas price (gwei)">
        <span className="text-gray-600">GAS</span>
        <span className={chain?.gasPriceGwei != null ? gasColor(chain.gasPriceGwei) : 'text-gray-600'}>
          {chain?.gasPriceGwei != null ? chain.gasPriceGwei.toFixed(0) : '--'}
        </span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Block height */}
      <span className="flex items-center gap-1.5" title="Latest Polygon block">
        <span className="text-gray-600">BLOCK</span>
        <span className="text-gray-400">
          {chain?.blockNumber != null
            ? chain.blockNumber.toLocaleString('en-US').replace(/,/g, ' ')
            : '--'}
        </span>
      </span>

      <span className="h-3 w-px bg-white/10" />

      {/* Socket state */}
      <span className="flex items-center gap-2">
        <span className={`status-dot ${connected ? 'status-dot-active animate-dot' : 'status-dot-error'}`} />
        <span className={connected ? 'text-green-400' : 'text-red-400'}>
          {connected ? 'LINKED' : 'DOWN'}
        </span>
      </span>
    </div>
  );
}
