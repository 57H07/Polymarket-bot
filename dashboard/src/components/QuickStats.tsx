import { useEffect, useRef, useState } from 'react';
import type { BotState, BotConfig } from '../types';
import { KpiCard } from './KpiCard';
import { signedUsd } from '../format';

interface QuickStatsProps {
  state: BotState | null;
  config: BotConfig | null;
}

const MAX_HISTORY = 24;

/** Rolling series for the KPI sparklines; seeded so a card draws from first paint. */
function useSeries(value: number): number[] {
  const [series, setSeries] = useState<number[]>(() => [value, value]);

  useEffect(() => {
    setSeries((prev) => [...prev, value].slice(-MAX_HISTORY));
  }, [value]);

  return series;
}

/** True for ~450ms after `value` changes — drives the KPI border flash. */
function useFlash(value: number): boolean {
  const [flash, setFlash] = useState(false);
  const previous = useRef(value);

  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlash(true);
    const timer = window.setTimeout(() => setFlash(false), 450);
    return () => window.clearTimeout(timer);
  }, [value]);

  return flash;
}

export function QuickStats({ state, config }: QuickStatsProps) {
  const realizedPnL = state?.totalPnL ?? 0;
  const unrealizedPnL = state?.unrealizedPnL ?? 0;
  // Total for display includes unrealized gains/losses
  const totalPnL = realizedPnL + unrealizedPnL;

  const dailyPnL = state?.dailyPnL ?? 0;
  const trades = state?.tradesExecuted ?? 0;
  const opportunities = state?.arbitrage?.opportunitiesFound ?? 0;
  const activeStrategies = [
    config?.smartMoney?.enabled,
    config?.arbitrage?.enabled,
    config?.dipArb?.enabled,
    config?.directTrading?.enabled,
  ].filter(Boolean).length;

  // Realised exits only: the same numbers the Session Summary panel shows, so
  // the two cannot disagree. Before this they were two different formulas.
  const wins = state?.wins ?? 0;
  const closed = state?.closedTrades ?? 0;
  const winRate = closed > 0 ? (wins / closed) * 100 : 0;

  const totalSeries = useSeries(totalPnL);
  const dailySeries = useSeries(dailyPnL);
  const winSeries = useSeries(winRate);
  const tradeSeries = useSeries(trades);
  const foundSeries = useSeries(opportunities);

  const totalFlash = useFlash(totalPnL);
  const dailyFlash = useFlash(dailyPnL);
  const tradeFlash = useFlash(trades);
  const foundFlash = useFlash(opportunities);

  const formatPnL = (value: number) => signedUsd(value);

  const openLabel =
    unrealizedPnL !== 0
      ? `${unrealizedPnL >= 0 ? '+' : ''}${unrealizedPnL.toFixed(2)} open`
      : undefined;

  return (
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,216px),1fr))]">
      <KpiCard
        label="Total P&L"
        value={formatPnL(totalPnL)}
        tone={totalPnL >= 0 ? 'gain' : 'loss'}
        delta={`$${realizedPnL.toFixed(2)}`}
        sub={openLabel ? `realised · ${openLabel}` : 'realised'}
        spark={totalSeries}
        highlight={totalFlash}
        delay={0.05}
        title={`Realized $${realizedPnL.toFixed(2)} · Open $${unrealizedPnL.toFixed(2)}`}
      />

      <KpiCard
        label="Today"
        value={formatPnL(dailyPnL)}
        tone={dailyPnL >= 0 ? 'gain' : 'loss'}
        delta={dailyPnL >= 0 ? 'up' : 'down'}
        sub="realised today"
        spark={dailySeries}
        highlight={dailyFlash}
        delay={0.12}
      />

      <KpiCard
        label="Win Rate"
        value={closed > 0 ? `${winRate.toFixed(0)}%` : '--'}
        tone="accent"
        delta={`${closed} closed`}
        sub={closed > 0 ? `${wins}W / ${closed - wins}L` : 'nothing exited yet'}
        arrow="◆"
        spark={winSeries}
        delay={0.19}
      />

      <KpiCard
        label="Trades"
        value={String(trades)}
        tone="info"
        delta={`${state?.smartMoneyTrades ?? 0} copies`}
        sub="executed"
        arrow="◆"
        spark={tradeSeries}
        highlight={tradeFlash}
        delay={0.26}
      />

      <KpiCard
        label="Active"
        value={`${activeStrategies}/4`}
        tone="warn"
        delta={activeStrategies > 0 ? 'running' : 'idle'}
        sub="strategies"
        arrow="◆"
        delay={0.33}
      />

      <KpiCard
        label="Found"
        value={String(opportunities)}
        tone="neutral"
        delta={`${state?.arbitrage?.marketsScanned ?? 0} scanned`}
        sub="markets"
        arrow="◆"
        spark={foundSeries}
        highlight={foundFlash}
        delay={0.4}
      />
    </section>
  );
}
