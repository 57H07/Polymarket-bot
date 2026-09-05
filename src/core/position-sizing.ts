/**
 * Position sizing and exit rules - pure functions shared by live and paper mode.
 */

export interface DynamicSizingConfig {
  enableDynamicSizing: boolean;
  /** Base size as a fraction of capital (e.g. 0.02 = 2%) */
  basePct: number;
  minPositionPct: number;
  maxPositionPct: number;
  /** Fractional reduction applied per consecutive loss beyond the second (0.2 = -20%) */
  lossSizingReduction: number;
  /** Fractional increase applied per consecutive win beyond the third (0.1 = +10%) */
  winSizingIncrease: number;
}

/**
 * Fraction of capital to commit to the next trade given the current streaks.
 * - Losses: after 2 consecutive losses, each further loss multiplies by (1 - lossSizingReduction).
 * - Wins: after 3 consecutive wins, each further win (max 5) adds winSizingIncrease.
 * The result is clamped to [minPositionPct, maxPositionPct].
 */
export function dynamicPositionPct(
  cfg: DynamicSizingConfig,
  streaks: { consecutiveLosses: number; consecutiveWins: number },
): number {
  let pct = cfg.basePct;

  if (cfg.enableDynamicSizing) {
    if (streaks.consecutiveLosses > 2) {
      pct *= Math.pow(1 - cfg.lossSizingReduction, streaks.consecutiveLosses - 2);
    }
    if (streaks.consecutiveWins > 3) {
      pct *= 1 + Math.min(streaks.consecutiveWins - 3, 5) * cfg.winSizingIncrease;
    }
  }

  return Math.min(cfg.maxPositionPct, Math.max(cfg.minPositionPct, pct));
}

export interface ExposureLimits {
  capitalUsd: number;
  maxPerTradePct: number;
  maxPerMarketPct: number;
  maxTotalExposurePct: number;
  minOrderUsd: number;
  /** Fraction of capital each strategy may have open at once */
  strategyAllocation: Record<string, number>;
}

export interface OpenExposure {
  /** Cost basis of every open position, in USD */
  total: number;
  /** Cost basis of open positions on this market */
  market: number;
  /** Cost basis of open positions opened by this strategy */
  strategy: number;
}

export interface ExposureDecision {
  allowed: boolean;
  /** Size after clamping to every limit (0 when not allowed) */
  sizeUsd: number;
  reason?: string;
}

/**
 * Clamp a desired order size to the capital limits and report why it was cut.
 * The order is refused when the clamped size is below `minOrderUsd`.
 */
export function checkExposure(
  limits: ExposureLimits,
  strategy: string,
  desiredUsd: number,
  open: OpenExposure,
): ExposureDecision {
  if (!(desiredUsd > 0)) return { allowed: false, sizeUsd: 0, reason: 'size must be positive' };

  const caps: Array<[string, number]> = [
    ['maxPerTrade', limits.capitalUsd * limits.maxPerTradePct],
    ['maxPerMarket', limits.capitalUsd * limits.maxPerMarketPct - open.market],
    ['maxTotalExposure', limits.capitalUsd * limits.maxTotalExposurePct - open.total],
  ];
  const allocation = limits.strategyAllocation[strategy];
  if (allocation !== undefined) {
    caps.push([`allocation:${strategy}`, limits.capitalUsd * allocation - open.strategy]);
  }

  let size = desiredUsd;
  let reason: string | undefined;
  for (const [name, cap] of caps) {
    if (cap < size) {
      size = cap;
      reason = name;
    }
  }

  if (size < limits.minOrderUsd) {
    return {
      allowed: false,
      sizeUsd: 0,
      reason: `${reason ?? 'size'} leaves $${Math.max(0, size).toFixed(2)} < min order $${limits.minOrderUsd}`,
    };
  }
  return { allowed: true, sizeUsd: size, reason };
}

// ============================================================================
// Exit rules (stop-loss / take-profit / trailing stop / max hold)
// ============================================================================

export interface ExitRules {
  stopLossPct: number;
  takeProfitPct: number;
  trailingStopPct: number;
  maxHoldDays: number;
}

export interface OpenTrade {
  entryPrice: number;
  /** Highest price seen since entry (updated by the caller) */
  peakPrice: number;
  openedAt: number;
}

export type ExitReason = 'stop_loss' | 'take_profit' | 'trailing_stop' | 'max_hold';

/**
 * Decide whether a long position should be closed at `price`.
 * Trailing stop only arms once the trade is in profit, so it never fires
 * before the fixed stop-loss on a trade that went straight down.
 */
export function evaluateExit(trade: OpenTrade, price: number, now: number, rules: ExitRules): ExitReason | null {
  if (!(trade.entryPrice > 0) || !(price > 0)) return null;
  const EPS = 1e-9;
  const change = (price - trade.entryPrice) / trade.entryPrice;

  if (rules.stopLossPct > 0 && change <= -rules.stopLossPct + EPS) return 'stop_loss';
  if (rules.takeProfitPct > 0 && change >= rules.takeProfitPct - EPS) return 'take_profit';

  if (rules.trailingStopPct > 0 && trade.peakPrice > trade.entryPrice) {
    const fromPeak = (trade.peakPrice - price) / trade.peakPrice;
    if (fromPeak >= rules.trailingStopPct - EPS) return 'trailing_stop';
  }

  if (rules.maxHoldDays > 0 && now - trade.openedAt >= rules.maxHoldDays * 24 * 60 * 60 * 1000) return 'max_hold';
  return null;
}
