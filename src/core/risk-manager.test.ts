import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  applyTrade,
  createRiskState,
  evaluateRisk,
  loadRiskState,
  saveRiskState,
  type RiskConfig,
} from './risk-manager.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const config: RiskConfig = {
  capitalUsd: 250,
  dailyMaxLossPct: 0.05,      // $12.50
  monthlyMaxLossPct: 0.15,    // $37.50
  maxDrawdownFromPeak: 0.25,
  totalMaxLossPct: 0.40,      // $100
  maxConsecutiveLosses: 6,
  pauseOnBreachMinutes: 60,
};

describe('applyTrade', () => {
  it('accumulates pnl across all periods', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, 3);
    applyTrade(s, -1.5);
    expect(s.tradesExecuted).toBe(2);
    expect(s.dailyPnL).toBeCloseTo(1.5);
    expect(s.monthlyPnL).toBeCloseTo(1.5);
    expect(s.totalPnL).toBeCloseTo(1.5);
  });

  it('tracks streaks and treats zero as neutral', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, -1);
    applyTrade(s, -1);
    expect(s.consecutiveLosses).toBe(2);
    applyTrade(s, 0);
    expect(s.consecutiveLosses).toBe(2);
    expect(s.consecutiveWins).toBe(0);
    applyTrade(s, 2);
    expect(s.consecutiveLosses).toBe(0);
    expect(s.consecutiveWins).toBe(1);
  });

  it('ignores NaN profits', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, NaN);
    expect(s.tradesExecuted).toBe(0);
    expect(s.totalPnL).toBe(0);
  });
});

describe('evaluateRisk', () => {
  it('allows trading on a fresh state', () => {
    const s = createRiskState(250, 0);
    expect(evaluateRisk(s, config, 0).allowed).toBe(true);
  });

  it('pauses for one hour after the daily loss limit and resumes afterwards', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, -12.5);
    const d = evaluateRisk(s, config, 1000);
    expect(d.allowed).toBe(false);
    expect(d.breach).toBe('daily_loss');
    expect(s.isPaused).toBe(true);

    expect(evaluateRisk(s, config, 1000 + 30 * 60 * 1000).allowed).toBe(false);

    // After the pause the daily loss is still at the limit, so it re-pauses
    const again = evaluateRisk(s, config, 1000 + HOUR + 1);
    expect(again.resumed).toBe(true);
    expect(again.allowed).toBe(false);
    expect(again.breach).toBe('daily_loss');

    // Next day the daily counter resets and trading resumes
    const nextDay = evaluateRisk(s, config, 1000 + DAY + HOUR + 2);
    expect(nextDay.allowed).toBe(true);
    expect(s.dailyPnL).toBe(0);
  });

  it('pauses for 30 days after the monthly loss limit', () => {
    const s = createRiskState(250, 0);
    let now = 0;
    // Lose $10 per day for 4 days: daily limit never hit, monthly is
    for (let i = 0; i < 4; i++) {
      now = i * DAY + 1;
      evaluateRisk(s, config, now);
      applyTrade(s, -10);
    }
    const d = evaluateRisk(s, config, now + 1);
    expect(d.breach).toBe('monthly_loss');
    expect(s.pauseUntil - (now + 1)).toBe(30 * DAY);
  });

  it('pauses on drawdown from peak even when net pnl is positive', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, 100);              // capital 350, peak 350
    evaluateRisk(s, config, 1);
    applyTrade(s, -90);              // capital 260, drawdown 25.7%
    const d = evaluateRisk(s, config, 2);
    expect(d.allowed).toBe(false);
    expect(d.breach).toBe('drawdown');
    expect(s.totalPnL).toBe(10);
  });

  it('halts permanently at the total loss limit and never resumes', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, -100);
    const d = evaluateRisk(s, config, 1);
    expect(d.breach).toBe('total_loss');
    expect(s.permanentlyHalted).toBe(true);
    const later = evaluateRisk(s, config, 1 + 365 * DAY);
    expect(later.allowed).toBe(false);
    expect(later.breach).toBe('permanent_halt');
  });

  it('total loss wins over an active daily pause', () => {
    const s = createRiskState(250, 0);
    applyTrade(s, -13);
    evaluateRisk(s, config, 1);     // daily pause
    applyTrade(s, -90);             // pushes total past -100 while paused
    const d = evaluateRisk(s, config, 2);
    expect(d.breach).toBe('total_loss');
    expect(s.permanentlyHalted).toBe(true);
  });

  it('pauses after too many consecutive losses', () => {
    const s = createRiskState(250, 0);
    for (let i = 0; i < 6; i++) applyTrade(s, -0.5);
    const d = evaluateRisk(s, config, 1);
    expect(d.breach).toBe('consecutive_losses');
  });
});

describe('persistence', () => {
  it('round-trips the state through disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-'));
    try {
      const file = join(dir, 'nested', 'risk-state.json');
      const s = createRiskState(250, 0);
      applyTrade(s, -100);
      evaluateRisk(s, config, 1);
      saveRiskState(file, s, 250);

      const loaded = loadRiskState(file);
      expect(loaded).not.toBeNull();
      expect(loaded!.capitalUsd).toBe(250);
      expect(loaded!.state.permanentlyHalted).toBe(true);
      expect(loaded!.state.totalPnL).toBe(-100);
      // A restart must not lift the permanent halt
      expect(evaluateRisk(loaded!.state, config, 10 * DAY).allowed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for missing or corrupt files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-'));
    try {
      expect(loadRiskState(join(dir, 'missing.json'))).toBeNull();
      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{not json');
      expect(loadRiskState(bad)).toBeNull();
      const wrongShape = join(dir, 'shape.json');
      writeFileSync(wrongShape, JSON.stringify({ version: 1, state: { totalPnL: 'oops' } }));
      expect(loadRiskState(wrongShape)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
