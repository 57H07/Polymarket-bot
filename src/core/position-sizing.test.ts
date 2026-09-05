import { describe, it, expect } from 'vitest';
import { checkExposure, dynamicPositionPct, evaluateExit } from './position-sizing.js';

const sizing = {
  enableDynamicSizing: true,
  basePct: 0.02,
  minPositionPct: 0.01,
  maxPositionPct: 0.05,
  lossSizingReduction: 0.2,
  winSizingIncrease: 0.1,
};

describe('dynamicPositionPct', () => {
  it('returns the base size with no streak', () => {
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 0, consecutiveWins: 0 })).toBeCloseTo(0.02);
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 2, consecutiveWins: 0 })).toBeCloseTo(0.02);
  });

  it('reduces 20% per loss after the second and floors at the minimum', () => {
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 3, consecutiveWins: 0 })).toBeCloseTo(0.016);
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 4, consecutiveWins: 0 })).toBeCloseTo(0.0128);
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 10, consecutiveWins: 0 })).toBe(0.01);
  });

  it('increases 10% per win after the third, capped at +50% and at the maximum', () => {
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 0, consecutiveWins: 4 })).toBeCloseTo(0.022);
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 0, consecutiveWins: 8 })).toBeCloseTo(0.03);
    expect(dynamicPositionPct(sizing, { consecutiveLosses: 0, consecutiveWins: 50 })).toBeCloseTo(0.03);
    expect(dynamicPositionPct({ ...sizing, basePct: 0.04 }, { consecutiveLosses: 0, consecutiveWins: 8 })).toBe(0.05);
  });

  it('ignores streaks when disabled', () => {
    expect(dynamicPositionPct({ ...sizing, enableDynamicSizing: false }, { consecutiveLosses: 9, consecutiveWins: 0 })).toBe(0.02);
  });
});

describe('checkExposure', () => {
  const limits = {
    capitalUsd: 250,
    maxPerTradePct: 0.02,       // $5
    maxPerMarketPct: 0.10,      // $25
    maxTotalExposurePct: 0.30,  // $75
    minOrderUsd: 1,
    strategyAllocation: { smartMoney: 0.6, direct: 0.1 }, // $150 / $25
  };
  const none = { total: 0, market: 0, strategy: 0 };

  it('clamps to the per-trade cap', () => {
    const d = checkExposure(limits, 'smartMoney', 20, none);
    expect(d.allowed).toBe(true);
    expect(d.sizeUsd).toBe(5);
    expect(d.reason).toBe('maxPerTrade');
  });

  it('refuses when the market is already at its cap', () => {
    const d = checkExposure(limits, 'smartMoney', 5, { total: 24.5, market: 24.5, strategy: 24.5 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('maxPerMarket');
  });

  it('refuses when total exposure is exhausted', () => {
    const d = checkExposure(limits, 'direct', 5, { total: 75, market: 0, strategy: 0 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('maxTotalExposure');
  });

  it('applies the strategy allocation', () => {
    const d = checkExposure(limits, 'direct', 5, { total: 23, market: 0, strategy: 23 });
    expect(d.allowed).toBe(true);
    expect(d.sizeUsd).toBe(2);
    expect(d.reason).toBe('allocation:direct');
  });

  it('lets unknown strategies through the other caps only', () => {
    const d = checkExposure(limits, 'arbitrage', 4, none);
    expect(d).toEqual({ allowed: true, sizeUsd: 4, reason: undefined });
  });
});

describe('evaluateExit', () => {
  const rules = { stopLossPct: 0.15, takeProfitPct: 0.25, trailingStopPct: 0.10, maxHoldDays: 7 };
  const day = 24 * 60 * 60 * 1000;

  it('fires the stop-loss and take-profit at their thresholds', () => {
    const t = { entryPrice: 0.50, peakPrice: 0.50, openedAt: 0 };
    expect(evaluateExit(t, 0.43, 1, rules)).toBeNull();
    expect(evaluateExit(t, 0.425, 1, rules)).toBe('stop_loss');
    expect(evaluateExit(t, 0.62, 1, rules)).toBeNull();
    expect(evaluateExit(t, 0.625, 1, rules)).toBe('take_profit');
  });

  it('arms the trailing stop only after a peak above entry', () => {
    expect(evaluateExit({ entryPrice: 0.50, peakPrice: 0.50, openedAt: 0 }, 0.45, 1, rules)).toBeNull();
    expect(evaluateExit({ entryPrice: 0.50, peakPrice: 0.60, openedAt: 0 }, 0.54, 1, rules)).toBe('trailing_stop');
    expect(evaluateExit({ entryPrice: 0.50, peakPrice: 0.60, openedAt: 0 }, 0.55, 1, rules)).toBeNull();
  });

  it('closes after the maximum holding period', () => {
    const t = { entryPrice: 0.50, peakPrice: 0.50, openedAt: 0 };
    expect(evaluateExit(t, 0.50, 6 * day, rules)).toBeNull();
    expect(evaluateExit(t, 0.50, 7 * day, rules)).toBe('max_hold');
  });

  it('ignores invalid prices', () => {
    expect(evaluateExit({ entryPrice: 0, peakPrice: 0, openedAt: 0 }, 0.5, 1, rules)).toBeNull();
    expect(evaluateExit({ entryPrice: 0.5, peakPrice: 0.5, openedAt: 0 }, NaN, 1, rules)).toBeNull();
  });
});
