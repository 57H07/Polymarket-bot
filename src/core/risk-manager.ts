/**
 * Risk Manager - pure, testable risk state machine with disk persistence.
 *
 * The bot previously kept all risk counters in memory and fed them a profit
 * of 0 for every trade, so the daily / monthly / drawdown / total-loss limits
 * could never trigger. This module centralises that logic so it can be unit
 * tested and survives restarts.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';

export interface RiskConfig {
  /** Capital used as the base for every percentage limit */
  capitalUsd: number;
  dailyMaxLossPct: number;
  monthlyMaxLossPct: number;
  maxDrawdownFromPeak: number;
  totalMaxLossPct: number;
  maxConsecutiveLosses: number;
  pauseOnBreachMinutes: number;
}

export interface RiskState {
  dailyPnL: number;
  monthlyPnL: number;
  totalPnL: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  tradesExecuted: number;
  isPaused: boolean;
  pauseUntil: number;
  pauseReason: string | null;
  lastDailyReset: number;
  monthStartTime: number;
  peakCapital: number;
  currentCapital: number;
  currentDrawdown: number;
  permanentlyHalted: boolean;
}

export type RiskBreach =
  | 'permanent_halt'
  | 'daily_loss'
  | 'monthly_loss'
  | 'drawdown'
  | 'consecutive_losses'
  | 'total_loss';

export interface RiskDecision {
  allowed: boolean;
  /** Set when this evaluation created a new pause or halt */
  breach?: RiskBreach;
  /** Set when a previous pause just expired */
  resumed?: boolean;
  /** Human readable messages produced during evaluation (resets, breaches) */
  messages: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRiskState(capitalUsd: number, now = Date.now()): RiskState {
  return {
    dailyPnL: 0,
    monthlyPnL: 0,
    totalPnL: 0,
    consecutiveLosses: 0,
    consecutiveWins: 0,
    tradesExecuted: 0,
    isPaused: false,
    pauseUntil: 0,
    pauseReason: null,
    lastDailyReset: now,
    monthStartTime: now,
    peakCapital: capitalUsd,
    currentCapital: capitalUsd,
    currentDrawdown: 0,
    permanentlyHalted: false,
  };
}

/**
 * Record a realised trade result. A profit of exactly 0 (e.g. an opening leg
 * whose result is not yet known) counts as a trade but does not touch the
 * win / loss streaks.
 */
export function applyTrade(state: RiskState, profit: number): void {
  if (!Number.isFinite(profit)) return;

  state.tradesExecuted++;
  state.dailyPnL += profit;
  state.monthlyPnL += profit;
  state.totalPnL += profit;

  if (profit < 0) {
    state.consecutiveLosses++;
    state.consecutiveWins = 0;
  } else if (profit > 0) {
    state.consecutiveLosses = 0;
    state.consecutiveWins++;
  }
}

/**
 * Evaluate whether a new trade may be opened. Mutates `state` (period resets,
 * pause bookkeeping, drawdown) and returns the decision.
 */
export function evaluateRisk(state: RiskState, config: RiskConfig, now = Date.now()): RiskDecision {
  const messages: string[] = [];

  if (state.permanentlyHalted) {
    return { allowed: false, breach: 'permanent_halt', messages };
  }

  // Period resets
  if (now - state.lastDailyReset >= DAY_MS) {
    messages.push(`Daily PnL reset. Previous day: $${state.dailyPnL.toFixed(2)}`);
    state.dailyPnL = 0;
    state.lastDailyReset = now;
  }
  if (now - state.monthStartTime >= 30 * DAY_MS) {
    messages.push(`Monthly PnL reset. Previous month: $${state.monthlyPnL.toFixed(2)}`);
    state.monthlyPnL = 0;
    state.monthStartTime = now;
  }

  // Capital / drawdown
  state.currentCapital = config.capitalUsd + state.totalPnL;
  if (state.currentCapital > state.peakCapital) state.peakCapital = state.currentCapital;
  state.currentDrawdown = state.peakCapital > 0
    ? (state.peakCapital - state.currentCapital) / state.peakCapital
    : 0;

  // Layer 4 first: total loss is permanent and must win over any temporary pause
  const totalLossLimit = config.capitalUsd * config.totalMaxLossPct;
  if (state.totalPnL <= -totalLossLimit) {
    state.permanentlyHalted = true;
    state.isPaused = true;
    state.pauseUntil = Number.MAX_SAFE_INTEGER;
    state.pauseReason = 'total_loss';
    messages.push(`TOTAL LOSS LIMIT REACHED: -$${Math.abs(state.totalPnL).toFixed(2)} (limit: $${totalLossLimit.toFixed(2)}) - trading permanently halted`);
    return { allowed: false, breach: 'total_loss', messages };
  }

  // Existing pause
  let resumed = false;
  if (state.isPaused) {
    if (now < state.pauseUntil) {
      return { allowed: false, messages };
    }
    state.isPaused = false;
    state.pauseUntil = 0;
    state.pauseReason = null;
    resumed = true;
    messages.push('Bot resumed after cooldown');
  }

  const pause = (breach: RiskBreach, durationMs: number, message: string): RiskDecision => {
    state.isPaused = true;
    state.pauseUntil = now + durationMs;
    state.pauseReason = breach;
    messages.push(message);
    return { allowed: false, breach, resumed, messages };
  };

  // Layer 1: daily loss
  const dailyLossLimit = config.capitalUsd * config.dailyMaxLossPct;
  if (state.dailyPnL <= -dailyLossLimit) {
    return pause('daily_loss', config.pauseOnBreachMinutes * 60 * 1000,
      `Daily loss limit breached: -$${Math.abs(state.dailyPnL).toFixed(2)} (limit: $${dailyLossLimit.toFixed(2)})`);
  }

  // Layer 2: monthly loss
  const monthlyLossLimit = config.capitalUsd * config.monthlyMaxLossPct;
  if (state.monthlyPnL <= -monthlyLossLimit) {
    return pause('monthly_loss', 30 * DAY_MS,
      `Monthly loss limit breached: -$${Math.abs(state.monthlyPnL).toFixed(2)} (limit: $${monthlyLossLimit.toFixed(2)})`);
  }

  // Layer 3: drawdown from peak
  if (state.currentDrawdown >= config.maxDrawdownFromPeak) {
    return pause('drawdown', 7 * DAY_MS,
      `Maximum drawdown reached: ${(state.currentDrawdown * 100).toFixed(1)}%`);
  }

  // Consecutive losses
  if (config.maxConsecutiveLosses > 0 && state.consecutiveLosses >= config.maxConsecutiveLosses) {
    state.consecutiveLosses = 0;
    return pause('consecutive_losses', config.pauseOnBreachMinutes * 60 * 1000,
      `${config.maxConsecutiveLosses} consecutive losses - pausing`);
  }

  return { allowed: true, resumed, messages };
}

// ============================================================================
// Persistence
// ============================================================================

const RISK_STATE_VERSION = 1;

interface PersistedRiskState {
  version: number;
  savedAt: number;
  capitalUsd: number;
  state: RiskState;
}

/**
 * Load a persisted risk state. Returns null when the file is missing or
 * unreadable. The capital stored alongside the state is compared with the
 * current configuration so that a changed CAPITAL_USD is visible in the log.
 */
export function loadRiskState(filePath: string): { state: RiskState; capitalUsd: number; savedAt: number } | null {
  try {
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<PersistedRiskState>;
    if (raw.version !== RISK_STATE_VERSION || !raw.state) return null;
    const base = createRiskState(raw.capitalUsd ?? 0);
    const state: RiskState = { ...base, ...raw.state };
    for (const key of Object.keys(base) as (keyof RiskState)[]) {
      if (key === 'pauseReason') {
        if (state.pauseReason !== null && typeof state.pauseReason !== 'string') return null;
        continue;
      }
      if (typeof state[key] !== typeof base[key]) return null;
    }
    return { state, capitalUsd: raw.capitalUsd ?? 0, savedAt: raw.savedAt ?? 0 };
  } catch {
    return null;
  }
}

/** Atomically persist the risk state (write to a temp file, then rename). */
export function saveRiskState(filePath: string, state: RiskState, capitalUsd: number): void {
  const payload: PersistedRiskState = {
    version: RISK_STATE_VERSION,
    savedAt: Date.now(),
    capitalUsd,
    state,
  };
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, filePath);
}
