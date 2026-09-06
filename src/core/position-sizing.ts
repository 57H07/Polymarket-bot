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
  /**
   * Fraction of capital allowed across every market of one event. A single
   * match carries a dozen markets - winner, spread, totals, both-halves - so
   * the per-market cap alone lets correlated bets stack far past it. Omit to
   * disable the cap.
   */
  maxPerEventPct?: number;
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
  /** Cost basis of open positions on any market of the same event */
  event?: number;
}

/**
 * Matches the ISO date Polymarket puts in a sports slug: `-2026-09-06`.
 * Month and day are range-checked: a loose `\d{2}-\d{2}` also matched the
 * `-2026-90-94` tail of `highest-temperature-in-dallas-on-september-6-2026-90-94`,
 * which would have grouped unrelated temperature bands as one event.
 */
const SLUG_DATE_RE = /^(.*?-\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))(?:-|$)/;

/**
 * Groups the markets of one event from their slugs.
 *
 * Polymarket names a match's markets by appending the market type to a common
 * prefix ending in the date: `lal-val-bar-2026-09-06-total-3pt5`,
 * `-draw`, `-spread-away-1pt5` all belong to one game. Everything up to and
 * including that date is the event.
 *
 * This is a heuristic on the slug, not an identifier from the API. Slugs that
 * carry no ISO date - `highest-temperature-in-dallas-on-september-6-2026-90-94`
 * - fall back to `fallback` (the condition id), which leaves those positions
 * grouped per market exactly as before: too little grouping, which is the safe
 * direction. A slug whose tail happens to read as a valid date would still be
 * misgrouped, so this is a heuristic, not a guarantee.
 */
export function eventKeyFromSlug(slug: string | undefined, fallback: string): string {
  if (!slug) return fallback;
  const match = SLUG_DATE_RE.exec(slug);
  return match ? match[1] : fallback;
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
  if (limits.maxPerEventPct !== undefined) {
    caps.push(['maxPerEvent', limits.capitalUsd * limits.maxPerEventPct - (open.event ?? open.market)]);
  }
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
