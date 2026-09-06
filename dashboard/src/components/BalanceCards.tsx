import type { BotState } from '../types';

interface BalanceCardsProps {
  state: BotState | null;
}

interface BalanceCardProps {
  label: string;
  value: string;
  subLabel?: string;
  /** Hex accent for the value and the corner aura. */
  color: string;
  delay: number;
}

function BalanceCard({ label, value, subLabel, color, delay }: BalanceCardProps) {
  return (
    <div
      className="card-sheen glass-card glass-card-hover dc-rise relative overflow-hidden px-4 py-3.5"
      style={{ borderRadius: '16px', animationDelay: `${delay.toFixed(2)}s` }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-8 -right-8 h-24 w-24 rounded-full blur-[6px]"
        style={{ background: `radial-gradient(circle, ${color}1f, transparent 68%)` }}
      />
      <div className="relative flex items-center justify-between gap-2">
        <span className="metric-label truncate">{label}</span>
        <span className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: color }} />
      </div>
      <div className="metric-value relative mt-2.5 truncate text-xl" style={{ color }}>
        {value}
      </div>
      {subLabel && (
        <div className="relative mt-2 truncate font-mono text-[10px] text-gray-500">{subLabel}</div>
      )}
    </div>
  );
}

export function BalanceCards({ state }: BalanceCardsProps) {
  const matic = state?.maticBalance ?? 0;
  const usdc = state?.usdcBalance ?? 0;
  const usdce = state?.usdcEBalance ?? 0;
  const total = usdc + usdce;

  const formatCurrency = (value: number, decimals: number = 2) => {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  };

  if (state?.paper) {
    const p = state.paper;
    const unrealized = state.unrealizedPnL ?? 0;
    const realized = p.pnl - unrealized;
    const equity = p.balance + (state.positions ?? []).reduce((s, pos: any) => s + (Number(pos.curPrice) || 0) * (Number(pos.size) || 0), 0);
    const sign = (v: number) => `${v >= 0 ? '+' : '-'}$${formatCurrency(Math.abs(v))}`;
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <BalanceCard
          label="Paper cash"
          value={`$${formatCurrency(p.balance)}`}
          subLabel={`start $${formatCurrency(p.initialBalance)}`}
          color="#4aa8ff"
          delay={0.06}
        />
        <BalanceCard
          label="Equity"
          value={`$${formatCurrency(equity)}`}
          subLabel="cash + positions"
          color="#ffc46b"
          delay={0.12}
        />
        <BalanceCard
          label="Realised"
          value={sign(realized)}
          subLabel={`${p.trades} fills`}
          color={realized >= 0 ? '#34e0b0' : '#ff6b7a'}
          delay={0.18}
        />
        <BalanceCard
          label="Unrealised"
          value={sign(unrealized)}
          subLabel="open positions"
          color={unrealized >= 0 ? '#34e0b0' : '#ff6b7a'}
          delay={0.24}
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <BalanceCard
        label="MATIC"
        value={formatCurrency(matic, 4)}
        subLabel="gas"
        color="#9b8cff"
        delay={0.06}
      />
      <BalanceCard
        label="USDC"
        value={`$${formatCurrency(usdc)}`}
        subLabel="bridged"
        color="#34e0b0"
        delay={0.12}
      />
      <BalanceCard
        label="USDC.e"
        value={`$${formatCurrency(usdce)}`}
        subLabel="native"
        color="#4aa8ff"
        delay={0.18}
      />
      <BalanceCard
        label="Total"
        value={`$${formatCurrency(total)}`}
        subLabel="capital"
        color="#ffc46b"
        delay={0.24}
      />
    </div>
  );
}
