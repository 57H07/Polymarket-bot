/**
 * Polymarket Bot v3.2 + Dashboard
 *
 * Run with: npx tsx bot-with-dashboard.ts
 * Dashboard: http://localhost:3001
 *
 * Two execution modes share exactly the same strategy code:
 *
 * - LIVE (DRY_RUN=false): orders go to the Polymarket CLOB, split/merge/redeem
 *   go on-chain through CTFClient.
 * - SIMULATION (DRY_RUN=true, default): orders are filled by a PaperBroker
 *   that walks the REAL orderbook level by level, honours limit prices, fails
 *   on insufficient depth, and charges gas on every on-chain operation. The
 *   paper account (balance, positions, fills, realised PnL) is persisted in
 *   data/paper-state.json so a simulation can run for days across restarts.
 *
 * Every strategy passes through the same gates in both modes: the persisted
 * risk manager (daily / monthly / drawdown / total-loss), dynamic position
 * sizing, exposure limits and the exit manager (stop-loss, take-profit,
 * trailing stop, max hold, auto-redeem of resolved markets).
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  OnchainService,
  DipArbService,
  type SmartMoneyTrade,
} from './src/index.js';
import { CTFClient, type MarketResolution, type TokenIds } from './src/clients/ctf-client.js';
import type { ArbitrageMarketConfig, ArbitrageOpportunity, ArbitrageExecutionResult } from './src/services/arbitrage-service.js';
import type { DipArbMarketConfig, DipArbSettleResult } from './src/services/dip-arb-types.js';
import type { MarketOrderParams } from './src/services/trading-service.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import { addSession, createSessionFromState, type TradeRecord } from './src/dashboard/session-history.js';
import {
  applyTrade,
  createRiskState,
  evaluateRisk,
  loadRiskState,
  saveRiskState,
  type RiskConfig,
  type RiskState,
} from './src/core/risk-manager.js';
import {
  checkExposure,
  dynamicPositionPct,
  evaluateExit,
  type ExitRules,
} from './src/core/position-sizing.js';
import { PaperBroker, type PaperOrderResult } from './src/core/paper-broker.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
    maxPerTradePct: 0.02,
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 1,   // Polymarket minimum order value
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      direct: 0.10,
    } as Record<string, number>,
  },

  risk: {
    dailyMaxLossPct: parseFloat(process.env.DAILY_MAX_LOSS_PCT || '0.05'),
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,
    monthlyMaxLossPct: parseFloat(process.env.MONTHLY_MAX_LOSS_PCT || '0.15'),
    maxDrawdownFromPeak: parseFloat(process.env.MAX_DRAWDOWN_PCT || '0.25'),
    totalMaxLossPct: parseFloat(process.env.TOTAL_MAX_LOSS_PCT || '0.40'),

    // Dynamic position sizing (see src/core/position-sizing.ts)
    enableDynamicSizing: true,
    minPositionPct: 0.01,
    maxPositionPct: 0.05,
    lossSizingReduction: 0.20,
    winSizingIncrease: 0.10,
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED !== 'false',
    topN: 20,
    maxFollowed: 10,
    minWinRate: 0.60,
    minPnl: 500,
    minTrades: 30,
    // Quality filters computed from the trader's closed positions
    minProfitFactor: 1.5,
    minConsistencyScore: 0.7,
    maxSingleTradeExposure: 0.3,
    checkLastNTrades: 10,
    historyDepth: 100,

    sizeScale: 0.1,
    maxSizePerTrade: 15,
    maxSlippage: 0.03,
    minTradeSize: 10,
    delay: 500,
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',
    profitThreshold: 0.01,
    minTradeSize: 20,
    maxTradeSize: 100,
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,
    executionCooldownMs: 5000,
    // Gas fee accounting
    estimatedGasCostUSD: 0.10,
    minNetProfit: 0.50,
  },

  dipArb: {
    enabled: process.env.DIPARB_ENABLED === 'true',
    coins: ['BTC', 'ETH', 'SOL'] as const,
    shares: 10,
    sumTarget: 0.92,
    autoRotate: true,
    autoExecute: true,
    minTradeValueUSD: 1.5,
  },

  onchain: {
    enabled: true,
    autoApprove: true,
    minMatic: 0.5,
  },

  binance: {
    enabled: process.env.TREND_ANALYSIS_ENABLED === 'true',
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const,
    interval: '15m' as const,
    trendThreshold: 2,
  },

  directTrading: {
    enabled: false,
    trendFollowing: true,
    minTrendStrength: 0.02,
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  simulation: {
    /** Taker fee applied to paper fills (Polymarket: 0 on most markets) */
    feeRate: parseFloat(process.env.PAPER_FEE_RATE || '0'),
    /** Start a fresh paper account instead of loading data/paper-state.json */
    reset: process.env.PAPER_RESET === 'true',
  },

  dryRun: process.env.DRY_RUN !== 'false',
};

/** Switching to LIVE from the browser is opt-in: it must be enabled in .env. */
const ALLOW_LIVE_TOGGLE = process.env.ALLOW_DASHBOARD_LIVE_TOGGLE || 'false';
const TOGGLEABLE_STRATEGIES = new Set<keyof typeof CONFIG>(['smartMoney', 'arbitrage', 'dipArb', 'directTrading', 'binance']);
const CRYPTO_MARKET_RE = /\b(btc|bitcoin|eth|ethereum|ether|sol|solana)\b/i;

type Strategy = 'smartMoney' | 'arbitrage' | 'dipArb' | 'direct' | 'manual';

// ============================================================================
// STATE
// ============================================================================

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  monthlyPnL: 0,
  monthStartTime: Date.now(),
  peakCapital: CONFIG.capital.totalUsd,
  currentCapital: CONFIG.capital.totalUsd,
  currentDrawdown: 0,
  permanentlyHalted: false,
  lastDailyReset: Date.now(),

  smartMoneyTrades: 0,
  arbTrades: 0,
  dipArbTrades: 0,
  directTrades: 0,
  arbProfit: 0,
  followedWallets: [],
  positions: [],
  activeArbMarket: null,
  activeDipArbMarket: null,
  splits: 0,
  merges: 0,
  redeems: 0,
  swaps: 0,
  usdcBalance: 0,
  usdcEBalance: 0,
  maticBalance: 0,
  unrealizedPnL: 0,
  btcTrend: 'neutral',
  ethTrend: 'neutral',
  solTrend: 'neutral',

  dipArb: {
    marketName: null,
    underlying: null,
    duration: null,
    endTime: null,
    upPrice: 0,
    downPrice: 0,
    sum: 0,
    status: 'idle',
    lastSignal: null,
    signals: [],
  },

  arbitrage: {
    status: 'idle',
    marketsScanned: 0,
    opportunitiesFound: 0,
    currentMarket: null,
    lastOpportunity: null,
  },

  smartMoneySignals: [],
};

const sessionTrades: TradeRecord[] = [];

// ============================================================================
// UTILITIES
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

function modeTag(): string {
  return CONFIG.dryRun ? '[SIM]' : '[LIVE]';
}

function writeJsonAtomic(file: string, payload: unknown) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2));
  renameSync(tmp, file);
}

// ============================================================================
// RISK MANAGEMENT (persisted, see src/core/risk-manager.ts)
// ============================================================================

function riskConfig(): RiskConfig {
  return {
    capitalUsd: CONFIG.capital.totalUsd,
    dailyMaxLossPct: CONFIG.risk.dailyMaxLossPct,
    monthlyMaxLossPct: CONFIG.risk.monthlyMaxLossPct,
    maxDrawdownFromPeak: CONFIG.risk.maxDrawdownFromPeak,
    totalMaxLossPct: CONFIG.risk.totalMaxLossPct,
    maxConsecutiveLosses: CONFIG.risk.maxConsecutiveLosses,
    pauseOnBreachMinutes: CONFIG.risk.pauseOnBreachMinutes,
  };
}

function riskStatePath(dryRun: boolean): string {
  return join(DATA_DIR, `risk-state.${dryRun ? 'dry' : 'live'}.json`);
}

let risk: RiskState = createRiskState(CONFIG.capital.totalUsd);
let lastHaltLog = 0;

function syncRiskToState() {
  state.dailyPnL = risk.dailyPnL;
  state.monthlyPnL = risk.monthlyPnL;
  state.totalPnL = risk.totalPnL;
  state.consecutiveLosses = risk.consecutiveLosses;
  state.consecutiveWins = risk.consecutiveWins;
  state.tradesExecuted = risk.tradesExecuted;
  state.isPaused = risk.isPaused;
  state.pauseUntil = risk.pauseUntil;
  state.lastDailyReset = risk.lastDailyReset;
  state.monthStartTime = risk.monthStartTime;
  state.peakCapital = risk.peakCapital;
  state.currentCapital = risk.currentCapital;
  state.currentDrawdown = risk.currentDrawdown;
  state.permanentlyHalted = risk.permanentlyHalted;
}

function persistRisk() {
  try {
    saveRiskState(riskStatePath(CONFIG.dryRun), risk, CONFIG.capital.totalUsd);
  } catch (err) {
    log('WARN', `Could not persist risk state: ${(err as Error).message}`);
  }
}

function loadRiskForCurrentMode() {
  const file = riskStatePath(CONFIG.dryRun);
  const loaded = CONFIG.dryRun && CONFIG.simulation.reset ? null : loadRiskState(file);
  if (loaded) {
    risk = loaded.state;
    const age = Math.round((Date.now() - loaded.savedAt) / 60000);
    log('INFO', `Risk state restored from ${file} (saved ${age} min ago): total PnL $${risk.totalPnL.toFixed(2)}, paused=${risk.isPaused}, halted=${risk.permanentlyHalted}`);
    if (loaded.capitalUsd !== CONFIG.capital.totalUsd) {
      log('WARN', `CAPITAL_USD changed since last run ($${loaded.capitalUsd} → $${CONFIG.capital.totalUsd}). Loss limits use the new value; delete ${file} to start fresh.`);
    }
  } else {
    risk = createRiskState(CONFIG.capital.totalUsd);
    log('INFO', `No risk state loaded for ${CONFIG.dryRun ? 'simulation' : 'live'} mode, starting fresh`);
  }
  syncRiskToState();
  updateDashboard();
}

function canTrade(): boolean {
  const wasPaused = risk.isPaused;
  const decision = evaluateRisk(risk, riskConfig());

  for (const message of decision.messages) {
    const level: LogLevel = decision.breach === 'total_loss' || decision.breach === 'permanent_halt'
      ? 'ERROR' : decision.breach ? 'WARN' : 'INFO';
    log(level, message);
  }

  if (decision.breach === 'permanent_halt' && Date.now() - lastHaltLog > 60_000) {
    log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
    lastHaltLog = Date.now();
  }

  syncRiskToState();
  if (decision.breach || decision.resumed || wasPaused !== risk.isPaused) {
    persistRisk();
    updateDashboard();
  }
  return decision.allowed;
}

/**
 * Record a realised trade result (real profit or loss in USD). Pass 0 for an
 * opening fill whose outcome is not yet known: it counts as a trade but does
 * not move PnL or win/loss streaks.
 */
function recordTrade(profit: number, strategy: Strategy, details?: Partial<TradeRecord>) {
  applyTrade(risk, profit);

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') { state.arbTrades++; state.arbProfit += profit; }
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;

  if (details && strategy !== 'manual') {
    sessionTrades.push({
      id: `t-${Date.now()}-${sessionTrades.length}`,
      timestamp: new Date().toISOString(),
      strategy,
      market: details.market ?? 'unknown',
      side: details.side ?? 'BUY',
      size: details.size ?? 0,
      price: details.price ?? 0,
      profit,
      wallet: details.wallet,
      txHash: details.txHash,
    });
  }

  syncRiskToState();
  persistRisk();
  canTrade(); // re-evaluate immediately so a breach pauses the bot before the next signal
  updateDashboard();
}

// ============================================================================
// POSITION SIZING & EXPOSURE
// ============================================================================

/** Fraction of capital for the next trade, adapted to the current streaks. */
function positionPct(): number {
  return dynamicPositionPct({
    enableDynamicSizing: CONFIG.risk.enableDynamicSizing,
    basePct: CONFIG.capital.maxPerTradePct,
    minPositionPct: CONFIG.risk.minPositionPct,
    maxPositionPct: CONFIG.risk.maxPositionPct,
    lossSizingReduction: CONFIG.risk.lossSizingReduction,
    winSizingIncrease: CONFIG.risk.winSizingIncrease,
  }, risk);
}

interface OpenTradeEntry {
  tokenId: string;
  conditionId: string;
  strategy: Strategy;
  outcome: string;
  title: string;
  usd: number;          // cost basis
  shares: number;
  entryPrice: number;
  openedAt: number;
  peakPrice: number;
}

/** Live-mode ledger of positions this bot opened (paper mode reads the broker instead). */
const liveTrades = new Map<string, OpenTradeEntry>();
const liveTradesFile = join(DATA_DIR, 'open-trades.live.json');

function loadLiveTrades() {
  try {
    if (!existsSync(liveTradesFile)) return;
    const raw = JSON.parse(readFileSync(liveTradesFile, 'utf-8')) as OpenTradeEntry[];
    for (const e of raw) liveTrades.set(e.tokenId, e);
    log('INFO', `Restored ${liveTrades.size} open live trades from ledger`);
  } catch { /* start empty */ }
}

function saveLiveTrades() {
  if (paper) return; // the paper broker owns positions in simulation
  try { writeJsonAtomic(liveTradesFile, [...liveTrades.values()]); } catch { /* ignore */ }
}

function openTrades(): OpenTradeEntry[] {
  if (paper) {
    return paper.getPositions().map(p => ({
      tokenId: p.tokenId,
      conditionId: p.conditionId,
      strategy: (p.strategy as Strategy) || 'manual',
      outcome: p.outcome,
      title: p.title || p.conditionId,
      usd: p.avgCost * p.shares,
      shares: p.shares,
      entryPrice: p.avgCost,
      openedAt: p.openedAt,
      peakPrice: p.peakPrice,
    }));
  }
  return [...liveTrades.values()];
}

/**
 * Clamp a desired order to the capital limits: dynamic per-trade size,
 * per-market cap, total exposure cap and per-strategy allocation.
 */
function sizeOrder(strategy: Strategy, desiredUsd: number, conditionId: string): { ok: boolean; usd: number; reason?: string } {
  const open = openTrades();
  const exposure = {
    total: open.reduce((s, t) => s + t.usd, 0),
    market: open.filter(t => t.conditionId === conditionId).reduce((s, t) => s + t.usd, 0),
    strategy: open.filter(t => t.strategy === strategy).reduce((s, t) => s + t.usd, 0),
  };
  const decision = checkExposure({
    capitalUsd: CONFIG.capital.totalUsd,
    maxPerTradePct: positionPct(),
    maxPerMarketPct: CONFIG.capital.maxPerMarketPct,
    maxTotalExposurePct: CONFIG.capital.maxTotalExposurePct,
    minOrderUsd: CONFIG.capital.minOrderUsd,
    strategyAllocation: CONFIG.capital.strategyAllocation,
  }, strategy, desiredUsd, exposure);
  return { ok: decision.allowed, usd: decision.sizeUsd, reason: decision.reason };
}

// ============================================================================
// EXECUTION LAYER (live CLOB/CTF or paper broker)
// ============================================================================

let sdk: PolymarketSDK;
let paper: PaperBroker | null = null;
let liveCtf: CTFClient | null = null;
let readOnlyCtf: CTFClient | null = null;

const paperStateFile = join(DATA_DIR, 'paper-state.json');

/** Mid price from the live orderbook (best bid when no ask, and vice versa). */
async function fetchMidPrice(tokenId: string): Promise<number | null> {
  try {
    const book = await sdk.markets.getTokenOrderbook(tokenId);
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (bid && ask) return (bid + ask) / 2;
    return bid ?? ask ?? null;
  } catch {
    return null;
  }
}

async function tokenIdsFor(conditionId: string): Promise<TokenIds & { title: string; outcomes: [string, string] }> {
  const market = await sdk.markets.getMarket(conditionId);
  if (!market?.tokens || market.tokens.length < 2) throw new Error(`market ${conditionId} has no tokens`);
  return {
    yesTokenId: market.tokens[0].tokenId,
    noTokenId: market.tokens[1].tokenId,
    title: market.question,
    outcomes: [market.tokens[0].outcome, market.tokens[1].outcome],
  };
}

/** Resolution from the chain first, Gamma as fallback (winner flag on closed markets). */
async function marketResolution(conditionId: string): Promise<MarketResolution> {
  try {
    const res = await readOnlyCtf!.getMarketResolution(conditionId);
    if (res.isResolved) return res;
  } catch { /* fall through */ }
  try {
    const market = await sdk.markets.getMarket(conditionId);
    if (market.closed && market.tokens?.length >= 2) {
      const yesWon = !!market.tokens[0].winner;
      const noWon = !!market.tokens[1].winner;
      if (yesWon !== noWon) {
        return {
          conditionId,
          isResolved: true,
          winningOutcome: yesWon ? 'YES' : 'NO',
          payoutNumerators: yesWon ? [1, 0] : [0, 1],
          payoutDenominator: 1,
        };
      }
    }
  } catch { /* not resolved */ }
  return { conditionId, isResolved: false, payoutNumerators: [0, 0], payoutDenominator: 0 };
}

function setupPaperBroker() {
  paper = new PaperBroker({
    initialBalance: CONFIG.capital.totalUsd,
    gasCostUsd: CONFIG.arbitrage.estimatedGasCostUSD,
    feeRate: CONFIG.simulation.feeRate,
    defaultSlippage: CONFIG.smartMoney.maxSlippage,
    stateFile: paperStateFile,
  }, {
    fetchBook: async (tokenId) => {
      const book = await sdk.markets.getTokenOrderbook(tokenId);
      return { bids: book.bids, asks: book.asks };
    },
    resolveTokenIds: async (conditionId) => {
      const t = await tokenIdsFor(conditionId);
      return { yesTokenId: t.yesTokenId, noTokenId: t.noTokenId };
    },
    getResolution: marketResolution,
  });

  if (!CONFIG.simulation.reset && paper.load()) {
    const s = paper.summary();
    log('INFO', `📝 Paper account restored: balance $${s.balance.toFixed(2)}, ${paper.getPositions().length} open positions, realised $${s.realizedPnl.toFixed(2)}, gas $${s.gasSpent.toFixed(2)}`);
  } else {
    paper.save();
    log('INFO', `📝 Paper account created with $${CONFIG.capital.totalUsd.toFixed(2)} (fills against live orderbooks, gas $${CONFIG.arbitrage.estimatedGasCostUSD}/op)`);
  }
  syncPaperToState();
}

function syncPaperToState() {
  if (!paper) return;
  const s = paper.summary();
  state.paper = {
    balance: s.balance,
    initialBalance: s.initialBalance,
    pnl: s.realizedPnl + s.unrealizedPnl,
    trades: s.fills,
    totalVolume: paper.getFills(1000).reduce((sum, f) => sum + Math.abs(f.usdc), 0),
  };
  state.usdcEBalance = s.balance;
  state.usdcBalance = 0;
  state.unrealizedPnL = s.unrealizedPnl;
}

interface FillInfo { success: boolean; error?: string; shares: number; avgPrice: number; usd: number; realizedPnl?: number; orderId?: string }

/**
 * Place a market order through the active execution layer.
 * BUY: `amount` is USDC. SELL: `amount` is shares.
 */
async function placeOrder(params: MarketOrderParams, strategy: Strategy, meta: { conditionId: string; outcome: string; title: string }): Promise<FillInfo> {
  if (paper) {
    paper.registerToken(params.tokenId, { conditionId: meta.conditionId, outcome: meta.outcome, title: meta.title, strategy });
    const r: PaperOrderResult = await paper.createMarketOrder({ ...params, strategy, conditionId: meta.conditionId });
    paper.save();
    syncPaperToState();
    return {
      success: r.success, error: r.errorMsg, orderId: r.orderId,
      shares: r.filledShares ?? 0, avgPrice: r.avgPrice ?? 0, usd: r.usdc ?? 0, realizedPnl: r.realizedPnl,
    };
  }

  const r = await sdk.tradingService.createMarketOrder(params);
  if (!r.success) return { success: false, error: r.errorMsg, shares: 0, avgPrice: 0, usd: 0 };

  // The CLOB does not return fill details synchronously: estimate from the price we sent
  const price = params.price ?? (await fetchMidPrice(params.tokenId)) ?? 0;
  const shares = params.side === 'BUY' ? (price > 0 ? params.amount / price : 0) : params.amount;
  const usd = params.side === 'BUY' ? params.amount : params.amount * price;

  if (params.side === 'BUY') {
    const existing = liveTrades.get(params.tokenId);
    if (existing) {
      const totalUsd = existing.usd + usd;
      const totalShares = existing.shares + shares;
      existing.usd = totalUsd;
      existing.shares = totalShares;
      existing.entryPrice = totalShares > 0 ? totalUsd / totalShares : existing.entryPrice;
    } else {
      liveTrades.set(params.tokenId, {
        tokenId: params.tokenId, conditionId: meta.conditionId, strategy, outcome: meta.outcome, title: meta.title,
        usd, shares, entryPrice: price, openedAt: Date.now(), peakPrice: price,
      });
    }
    saveLiveTrades();
    return { success: true, orderId: r.orderId, shares, avgPrice: price, usd };
  }

  const entry = liveTrades.get(params.tokenId);
  let realizedPnl: number | undefined;
  if (entry) {
    const sold = Math.min(shares, entry.shares);
    realizedPnl = sold * price - sold * entry.entryPrice;
    entry.shares -= sold;
    entry.usd = entry.shares * entry.entryPrice;
    if (entry.shares <= 1e-6) liveTrades.delete(params.tokenId);
    saveLiveTrades();
  }
  return { success: true, orderId: r.orderId, shares, avgPrice: price, usd, realizedPnl };
}

/** Redeem a resolved position through the active layer. Returns realised PnL (net of gas) or null. */
async function redeemTrade(entry: OpenTradeEntry): Promise<number | null> {
  const ids = await tokenIdsFor(entry.conditionId);
  const tokenIds = { yesTokenId: ids.yesTokenId, noTokenId: ids.noTokenId };
  if (paper) {
    const before = paper.getRealizedPnl();
    await paper.redeemByTokenIds(entry.conditionId, tokenIds);
    paper.save();
    syncPaperToState();
    return paper.getRealizedPnl() - before;
  }
  if (!liveCtf) return null;
  const result = await liveCtf.redeemByTokenIds(entry.conditionId, tokenIds);
  if (!result.success) return null;
  const received = parseFloat(result.usdcReceived || '0');
  const cost = [...liveTrades.values()].filter(t => t.conditionId === entry.conditionId).reduce((s, t) => s + t.usd, 0);
  for (const t of [...liveTrades.values()]) if (t.conditionId === entry.conditionId) liveTrades.delete(t.tokenId);
  saveLiveTrades();
  return received - cost - CONFIG.arbitrage.estimatedGasCostUSD;
}

// ============================================================================
// 1. SMART MONEY (copy trading with quality filters)
// ============================================================================

let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;
let smartMoneySubscription: { unsubscribe: () => void } | null = null;

interface TraderQuality {
  winRate: number; profitFactor: number; consistency: number; whaleShare: number; closedTrades: number;
}

/** Track-record metrics from a trader's closed positions (realised PnL per market). */
async function traderQuality(address: string): Promise<TraderQuality | null> {
  const closed = await sdk.dataApi.getClosedPositions(address, { limit: CONFIG.smartMoney.historyDepth });
  if (!closed.length) return null;
  const pnls = closed.map(p => Number(p.realizedPnl) || 0);
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const totalWins = wins.reduce((s, p) => s + p, 0);
  const totalLosses = Math.abs(losses.reduce((s, p) => s + p, 0));
  const recent = [...closed].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, CONFIG.smartMoney.checkLastNTrades);
  const recentWins = recent.filter(p => (Number(p.realizedPnl) || 0) > 0).length;
  const absSorted = pnls.map(Math.abs).sort((a, b) => b - a);
  const totalAbs = absSorted.reduce((s, v) => s + v, 0);
  return {
    winRate: wins.length / pnls.length,
    profitFactor: totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? 999 : 0),
    consistency: recent.length ? recentWins / recent.length : 0,
    whaleShare: totalAbs > 0 ? absSorted[0] / totalAbs : 0,
    closedTrades: pnls.length,
  };
}

async function initializeSmartMoney() {
  if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;
  isSmartMoneyInitializing = true;
  log('WALLET', 'Setting up Smart Money with quality filtering (win rate, profit factor, consistency, whale check)...');

  const cfg = CONFIG.smartMoney;
  const qualified: string[] = [];
  for (const wallet of cfg.customWallets) {
    qualified.push(wallet.toLowerCase());
    log('WALLET', `⭐ Custom wallet added: ${wallet.slice(0, 10)}...`);
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', cfg.topN * 2, 'pnl');
    for (const entry of leaderboard) {
      if (!CONFIG.smartMoney.enabled) break;
      if (qualified.length >= cfg.maxFollowed) break;
      const address = entry.address.toLowerCase();
      if (qualified.includes(address)) continue;
      if ((entry.pnl ?? 0) < cfg.minPnl) continue;

      try {
        const q = await traderQuality(address);
        if (!q) continue;
        const failures: string[] = [];
        if (q.closedTrades < cfg.minTrades) failures.push(`trades ${q.closedTrades}<${cfg.minTrades}`);
        if (q.winRate < cfg.minWinRate) failures.push(`WR ${(q.winRate * 100).toFixed(0)}%<${cfg.minWinRate * 100}%`);
        if (q.profitFactor < cfg.minProfitFactor) failures.push(`PF ${q.profitFactor.toFixed(2)}<${cfg.minProfitFactor}`);
        if (q.consistency < cfg.minConsistencyScore) failures.push(`consistency ${(q.consistency * 100).toFixed(0)}%<${cfg.minConsistencyScore * 100}%`);
        if (q.whaleShare > cfg.maxSingleTradeExposure) failures.push(`whale ${(q.whaleShare * 100).toFixed(0)}%>${cfg.maxSingleTradeExposure * 100}%`);

        if (failures.length === 0) {
          qualified.push(address);
          log('WALLET', `✅ Qualified ${address.slice(0, 10)}... WR:${(q.winRate * 100).toFixed(0)}% PF:${q.profitFactor.toFixed(2)}x Cons:${(q.consistency * 100).toFixed(0)}% PnL:$${(entry.pnl ?? 0).toFixed(0)}`);
        } else {
          log('WALLET', `❌ Rejected ${address.slice(0, 10)}...: ${failures.join(', ')}`);
        }
      } catch (err) {
        log('WARN', `Quality check failed for ${address.slice(0, 10)}...: ${(err as Error).message}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }
  } catch (err) {
    log('WARN', `Leaderboard error: ${(err as Error).message}`);
  }

  state.followedWallets = qualified;
  log('WALLET', `Following ${qualified.length} wallets`);
  updateDashboard();

  if (qualified.length > 0) {
    smartMoneySubscription = sdk.smartMoney.subscribeSmartMoneyTrades(
      (trade: SmartMoneyTrade) => { void handleSmartMoneyTrade(trade); },
      { filterAddresses: qualified },
    );
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}

function stopSmartMoney() {
  smartMoneySubscription?.unsubscribe();
  smartMoneySubscription = null;
  isSmartMoneyInitialized = false;
}

async function handleSmartMoneyTrade(trade: SmartMoneyTrade) {
  if (!CONFIG.smartMoney.enabled) return;

  const signal: SmartMoneySignal = {
    id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    timestamp: new Date().toISOString(),
    wallet: trade.traderAddress,
    market: trade.marketSlug || 'Unknown',
    side: trade.side,
    size: trade.size,
    price: trade.price,
  };
  state.smartMoneySignals.unshift(signal);
  if (state.smartMoneySignals.length > 50) state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
  log('SIGNAL', `Copy signal from ${trade.traderAddress.slice(0, 10)}...: ${trade.side} ${trade.size.toFixed(1)} @ ${trade.price.toFixed(3)} ${trade.marketSlug?.slice(0, 50) || ''}`);
  updateDashboard();

  if (!trade.tokenId || !(trade.price > 0) || !(trade.size > 0)) return;
  const cfg = CONFIG.smartMoney;
  const meta = { conditionId: trade.conditionId || 'unknown', outcome: trade.outcome || '?', title: trade.marketSlug || trade.conditionId || 'unknown' };

  // Leader SELL: close our copy of that position (if any)
  if (trade.side === 'SELL') {
    const held = openTrades().find(t => t.tokenId === trade.tokenId);
    if (!held) return;
    let shares = Math.min(held.shares, trade.size * cfg.sizeScale);
    if ((held.shares - shares) * trade.price < 1) shares = held.shares; // avoid unsellable dust
    const limit = Math.max(0.01, trade.price * (1 - cfg.maxSlippage));
    const fill = await placeOrder({ tokenId: trade.tokenId, side: 'SELL', amount: shares, price: limit, orderType: 'FAK' }, 'smartMoney', meta);
    if (fill.success) {
      const pnl = fill.realizedPnl ?? 0;
      log('TRADE', `${modeTag()} Copied SELL ${fill.shares.toFixed(2)} sh @ ${fill.avgPrice.toFixed(3)} | realised $${pnl.toFixed(2)}`);
      recordTrade(pnl, 'smartMoney', { market: meta.title, side: 'SELL', size: fill.shares, price: fill.avgPrice, wallet: trade.traderAddress });
    } else {
      log('WARN', `${modeTag()} Copy SELL failed: ${fill.error}`);
    }
    return;
  }

  // Leader BUY
  if (!canTrade()) return;
  const leaderValue = trade.size * trade.price;
  if (leaderValue < cfg.minTradeSize) return;
  const desired = Math.min(leaderValue * cfg.sizeScale, cfg.maxSizePerTrade);
  const sized = sizeOrder('smartMoney', desired, meta.conditionId);
  if (!sized.ok) {
    log('INFO', `Copy skipped (${sized.reason})`);
    return;
  }
  if (cfg.delay > 0) await new Promise(r => setTimeout(r, cfg.delay));

  const limit = Math.min(0.99, trade.price * (1 + cfg.maxSlippage));
  const fill = await placeOrder({ tokenId: trade.tokenId, side: 'BUY', amount: sized.usd, price: limit, orderType: 'FOK' }, 'smartMoney', meta);
  if (fill.success) {
    log('TRADE', `${modeTag()} Copied BUY $${fill.usd.toFixed(2)} (${fill.shares.toFixed(2)} sh @ ${fill.avgPrice.toFixed(3)}) from ${trade.traderAddress.slice(0, 8)}...${sized.reason ? ` [capped: ${sized.reason}]` : ''}`);
    recordTrade(0, 'smartMoney', { market: meta.title, side: 'BUY', size: fill.shares, price: fill.avgPrice, wallet: trade.traderAddress });
  } else {
    log('WARN', `${modeTag()} Copy BUY failed: ${fill.error}`);
  }
}

// ============================================================================
// 2. ARBITRAGE (bot-driven execution with gas accounting)
// ============================================================================

let arbService: ArbitrageService | null = null;
let lastArbExecution = 0;
let arbExecuting = false;

async function setupArbitrage() {
  log('ARB', `Setting up Arbitrage Service ${modeTag()}...`);
  state.arbitrage.status = 'idle';
  updateDashboard();

  arbService = new ArbitrageService({
    privateKey: paper ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    tradingClient: paper ?? undefined,
    ctfClient: paper ?? undefined,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: Math.min(CONFIG.arbitrage.maxTradeSize, CONFIG.capital.totalUsd * CONFIG.capital.strategyAllocation.arbitrage),
    // The bot decides when to execute (risk gate, gas, sizing) - never the service
    autoExecute: false,
    enableRebalancer: CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
  });

  arbService.on('opportunity', (opp: ArbitrageOpportunity) => { void handleArbOpportunity(opp); });

  arbService.on('execution', (result: ArbitrageExecutionResult) => {
    if (!result.success) log('WARN', `Arb execution failed: ${result.error}`);
  });

  if (CONFIG.arbitrage.enabled) await startArbitrageScan(CONFIG.arbitrage.minVolume24h);
}

async function startArbitrageScan(minVolume24h: number) {
  if (!arbService) return;
  state.arbitrage.status = 'scanning';
  updateDashboard();
  try {
    const results = await arbService.scanMarkets({ minVolume24h }, CONFIG.arbitrage.profitThreshold);
    state.arbitrage.marketsScanned = results.length;
    const best = results.find(r => r.arbType !== 'none') || results[0];
    if (best) {
      await startArbitrageMarket(best.market);
    } else {
      state.arbitrage.status = 'idle';
      log('ARB', 'No arbitrage markets found');
    }
  } catch (err) {
    state.arbitrage.status = 'idle';
    log('WARN', `Arbitrage scan error: ${(err as Error).message}`);
  }
  updateDashboard();
}

async function startArbitrageMarket(market: ArbitrageMarketConfig) {
  if (!arbService) return;
  paper?.registerMarket(market.conditionId, { yesTokenId: market.yesTokenId, noTokenId: market.noTokenId }, {
    title: market.name, strategy: 'arbitrage', outcomes: market.outcomes,
  });
  await arbService.start(market);
  state.activeArbMarket = market.name;
  state.arbitrage.currentMarket = market.name;
  state.arbitrage.status = 'monitoring';
  log('ARB', `Monitoring: ${market.name}`);
  updateDashboard();
}

async function handleArbOpportunity(opp: ArbitrageOpportunity) {
  state.arbitrage.opportunitiesFound++;
  state.arbitrage.lastOpportunity = {
    timestamp: new Date().toISOString(),
    type: opp.type,
    profitPct: opp.profitRate,
    market: state.arbitrage.currentMarket || 'Unknown',
  };
  updateDashboard();

  if (!CONFIG.arbitrage.enabled || !CONFIG.arbitrage.autoExecute || !arbService) return;
  if (arbExecuting || Date.now() - lastArbExecution < CONFIG.arbitrage.executionCooldownMs) return;
  if (!canTrade()) return;

  // Size: service recommendation, capped by dynamic sizing and exposure limits
  const conditionId = arbService.getMarket()?.conditionId || 'arb';
  const sized = sizeOrder('arbitrage', opp.recommendedSize, conditionId);
  if (!sized.ok) {
    log('INFO', `Arb skipped (${sized.reason})`);
    return;
  }
  const size = Math.min(sized.usd, opp.recommendedSize);
  if (size < CONFIG.arbitrage.minTradeSize) {
    log('INFO', `Arb skipped: size $${size.toFixed(2)} < minTradeSize $${CONFIG.arbitrage.minTradeSize}`);
    return;
  }

  // Gas accounting: a long arb costs a merge, a short arb a split (done by the rebalancer)
  const gas = CONFIG.arbitrage.estimatedGasCostUSD;
  const grossProfit = opp.profitRate * size;
  const netProfit = grossProfit - gas;
  if (netProfit < CONFIG.arbitrage.minNetProfit) {
    log('INFO', `Arb skipped: net $${netProfit.toFixed(2)} (gross $${grossProfit.toFixed(2)} - gas $${gas.toFixed(2)}) < min $${CONFIG.arbitrage.minNetProfit}`);
    return;
  }

  arbExecuting = true;
  try {
    log('ARB', `${modeTag()} Executing ${opp.type.toUpperCase()} arb: size $${size.toFixed(2)}, +${(opp.profitRate * 100).toFixed(2)}%, net est. $${netProfit.toFixed(2)}`);
    const before = paper?.getRealizedPnl() ?? 0;
    const result = await arbService.execute({ ...opp, recommendedSize: size });
    lastArbExecution = Date.now();
    if (result.success) {
      // Paper: exact realised delta from the broker (fills + merge - gas). Live: service estimate minus gas.
      const profit = paper ? paper.getRealizedPnl() - before : result.profit - gas;
      paper?.save();
      syncPaperToState();
      state.merges++;
      log('TRADE', `${modeTag()} Arb ${result.type} done: size $${result.size.toFixed(2)} | realised $${profit.toFixed(2)}`);
      recordTrade(profit, 'arbitrage', { market: state.arbitrage.currentMarket || 'arb', side: 'BUY', size: result.size, price: 1 - opp.profitRate, txHash: result.txHashes[0] });
    }
  } catch (err) {
    log('WARN', `Arb execution error: ${(err as Error).message}`);
  } finally {
    arbExecuting = false;
  }
}

// ============================================================================
// 3. DIP ARB (same DipArbService in both modes, paper clients injected in simulation)
// ============================================================================

let dipArb: DipArbService;
const dipArbRounds = new Map<string, { leg1Cost: number; leg2Cost: number; shares: number }>();

function createDipArbService(): DipArbService {
  if (paper) {
    return new DipArbService(sdk.realtime, paper, sdk.markets, undefined, 137, paper);
  }
  return sdk.dipArb;
}

function registerDipArbMarket(market: DipArbMarketConfig) {
  paper?.registerMarket(market.conditionId, { yesTokenId: market.upTokenId, noTokenId: market.downTokenId }, {
    title: market.name, strategy: 'dipArb', outcomes: ['UP', 'DOWN'],
  });
}

async function setupDipArb() {
  log('ARB', `Setting up DipArb Service ${modeTag()}...`);
  dipArb = createDipArbService();

  dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: CONFIG.dipArb.autoExecute,
    debug: true,
  });

  dipArb.on('orderbookUpdate', (update: { upPrice: number; downPrice: number; sum: number }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  const onMarket = (market: DipArbMarketConfig) => {
    registerDipArbMarket(market);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active';
    updateDashboard();
    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  };

  dipArb.on('started', (market: DipArbMarketConfig) => {
    log('ARB', `DipArb monitoring: ${market.name}`);
    onMarket(market);
  });

  dipArb.on('rotate', (e: { newMarket: string; market?: DipArbMarketConfig }) => {
    log('ARB', `DipArb rotated to ${e.newMarket}`);
    const m = dipArb.getMarket();
    if (m) onMarket(m); else { state.activeDipArbMarket = e.newMarket; state.dipArb.marketName = e.newMarket; updateDashboard(); }
  });

  dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    log('ARB', `New round: ${round.roundId}, Price to Beat: ${round.priceToBeat}`);
    // Risk gate: if trading is not allowed, keep the service from opening new legs this round
    const allowed = canTrade();
    dipArb.updateConfig({ autoExecute: CONFIG.dipArb.enabled && CONFIG.dipArb.autoExecute && allowed });
    updateDashboard();
  });

  dipArb.on('signal', (s: { type: 'leg1' | 'leg2'; dipSide?: string; hedgeSide?: string; currentPrice: number; dropPercent?: number }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type,
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    log('SIGNAL', `DipArb ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);
    updateDashboard();
  });

  dipArb.on('execution', (r: { success: boolean; leg: 'leg1' | 'leg2' | 'merge' | 'exit'; roundId: string; side?: string; price?: number; shares?: number; error?: string }) => {
    if (!r.success) {
      log('WARN', `DipArb execution failed (${r.leg}): ${r.error || 'Unknown error'}`);
      return;
    }
    paper?.save();
    syncPaperToState();
    const priceStr = r.price ? r.price.toFixed(3) : '??';
    const sharesStr = r.shares ? r.shares.toFixed(1) : '??';
    const market = state.activeDipArbMarket || 'unknown-market';
    const round = dipArbRounds.get(r.roundId) || { leg1Cost: 0, leg2Cost: 0, shares: 0 };
    const gas = CONFIG.arbitrage.estimatedGasCostUSD;

    switch (r.leg) {
      case 'leg1':
        round.leg1Cost = (r.price || 0) * (r.shares || 0);
        round.shares = r.shares || 0;
        dipArbRounds.set(r.roundId, round);
        log('TRADE', `${modeTag()} DipArb OPEN ${r.side} | ${sharesStr} sh @ $${priceStr} | ${market}`);
        recordTrade(0, 'dipArb', { market, side: 'BUY', size: r.shares, price: r.price });
        break;
      case 'leg2':
        round.leg2Cost = (r.price || 0) * (r.shares || 0);
        dipArbRounds.set(r.roundId, round);
        log('TRADE', `${modeTag()} DipArb HEDGE ${r.side} | ${sharesStr} sh @ $${priceStr} | pair cost $${(round.leg1Cost + round.leg2Cost).toFixed(2)}`);
        recordTrade(0, 'dipArb', { market, side: 'BUY', size: r.shares, price: r.price });
        break;
      case 'exit': {
        const proceeds = (r.price || 0) * (r.shares || 0);
        const profit = round.leg1Cost > 0 ? proceeds - round.leg1Cost : 0;
        dipArbRounds.delete(r.roundId);
        log('TRADE', `${modeTag()} DipArb CLOSE ${r.side} (timeout) | ${sharesStr} sh @ $${priceStr} | realised $${profit.toFixed(2)}`);
        recordTrade(profit, 'dipArb', { market, side: 'SELL', size: r.shares, price: r.price });
        break;
      }
      case 'merge': {
        const pairs = r.shares || round.shares;
        const cost = round.leg1Cost + round.leg2Cost;
        const profit = cost > 0 ? pairs - cost - gas : 0;
        dipArbRounds.delete(r.roundId);
        state.merges++;
        log('TRADE', `${modeTag()} DipArb MERGE ${pairs.toFixed(1)} pairs → $${pairs.toFixed(2)} | cost $${cost.toFixed(2)} + gas $${gas.toFixed(2)} | realised $${profit.toFixed(2)}`);
        recordTrade(profit, 'dipArb', { market, side: 'SELL', size: pairs, price: 1 });
        break;
      }
    }
  });

  dipArb.on('settled', (s: DipArbSettleResult) => {
    paper?.save();
    syncPaperToState();
    if (!s.success) {
      log('WARN', `DipArb settle failed for ${s.market?.name}: ${s.error}`);
      return;
    }
    state.redeems++;
    const received = s.amountReceived ?? 0;
    // Redeem pays $1 per winning share; cost basis for unhedged rounds is unknown to the
    // service, so use the last round costs we tracked for this market (best effort).
    log('TRADE', `${modeTag()} DipArb REDEEM ${s.market?.name}: received $${received.toFixed(2)} (gas $${CONFIG.arbitrage.estimatedGasCostUSD})`);
    if (paper) {
      // Paper broker already booked the exact realised PnL of the redeem in its fills
      const last = paper.getFills(1)[0];
      if (last?.kind === 'REDEEM') recordTrade(last.realizedPnl, 'dipArb', { market: s.market?.name, side: 'SELL', size: last.shares, price: last.avgPrice });
    } else {
      recordTrade(-CONFIG.arbitrage.estimatedGasCostUSD, 'dipArb', { market: s.market?.name, side: 'SELL', size: received, price: 1 });
    }
  });

  if (CONFIG.dipArb.autoRotate) {
    dipArb.enableAutoRotate({
      enabled: true,
      underlyings: [...CONFIG.dipArb.coins],
      duration: '15m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  if (CONFIG.dipArb.enabled) await startDipArb();
}

async function startDipArb() {
  try {
    const market = await dipArb.findAndStart({ coin: CONFIG.dipArb.coins[0], preferDuration: '15m' });
    if (market) log('ARB', `DipArb started: ${market.name}`);
    else log('WARN', 'No DipArb markets found');
  } catch (err) {
    log('WARN', `DipArb setup error: ${(err as Error).message}`);
  }
  updateDashboard();
}

// ============================================================================
// 4. DIRECT TRADING (Binance trend) + EXIT MANAGER
// ============================================================================

async function setupBinanceAnalysis() {
  if (!CONFIG.binance.enabled) return;
  log('KLINE', 'Setting up Binance K-line analysis...');

  async function analyzeTrend(symbol: 'BTCUSDT' | 'ETHUSDT' | 'SOLUSDT'): Promise<'up' | 'down' | 'neutral'> {
    try {
      const klines = await sdk.binance.getKLines(symbol, CONFIG.binance.interval, { limit: 20 });
      if (klines.length < 10) return 'neutral';
      const recent = klines.slice(-5);
      const older = klines.slice(-10, -5);
      const recentAvg = recent.reduce((s, k) => s + k.close, 0) / recent.length;
      const olderAvg = older.reduce((s, k) => s + k.close, 0) / older.length;
      const change = (recentAvg - olderAvg) / olderAvg;
      if (change > CONFIG.binance.trendThreshold / 100) return 'up';
      if (change < -CONFIG.binance.trendThreshold / 100) return 'down';
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async function updateTrends() {
    state.btcTrend = await analyzeTrend('BTCUSDT');
    state.ethTrend = await analyzeTrend('ETHUSDT');
    state.solTrend = await analyzeTrend('SOLUSDT');
    log('TREND', `BTC:${state.btcTrend} ETH:${state.ethTrend} SOL:${state.solTrend}`);
    updateDashboard();
  }

  await updateTrends();
  setInterval(updateTrends, 5 * 60 * 1000);
}

function exitRules(): ExitRules {
  const d = CONFIG.directTrading;
  return { stopLossPct: d.stopLossPct, takeProfitPct: d.takeProfitPct, trailingStopPct: d.trailingStopPct, maxHoldDays: d.maxHoldDays };
}

async function setupDirectTrading() {
  const d = CONFIG.directTrading;
  const riskReward = d.stopLossPct > 0 ? d.takeProfitPct / d.stopLossPct : Infinity;
  if (riskReward < d.minRiskReward) {
    log('WARN', `Direct trading disabled: take-profit/stop-loss ratio ${riskReward.toFixed(2)} < minRiskReward ${d.minRiskReward}`);
    d.enabled = false;
  }
  log('INFO', `Direct trading ${d.enabled ? 'enabled' : 'waiting for toggle'} (SL ${d.stopLossPct * 100}% / TP ${d.takeProfitPct * 100}% / trail ${d.trailingStopPct * 100}% / max ${d.maxHoldDays}d)`);

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled || !CONFIG.directTrading.trendFollowing) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);
      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;
        const question = market.question || '';
        if (!CRYPTO_MARKET_RE.test(question)) continue;

        let trend: 'up' | 'down' | 'neutral' = 'neutral';
        if (/\b(btc|bitcoin)\b/i.test(question)) trend = state.btcTrend;
        else if (/\b(eth|ethereum|ether)\b/i.test(question)) trend = state.ethTrend;
        else if (/\b(sol|solana)\b/i.test(question)) trend = state.solTrend;
        if (trend === 'neutral') continue;

        try {
          const full = await sdk.getMarket(market.conditionId);
          const yesToken = full.tokens.find(t => t.outcome === 'Yes');
          const noToken = full.tokens.find(t => t.outcome === 'No');
          if (!yesToken || !noToken) continue;
          const target = trend === 'up' ? yesToken : noToken;

          if (openTrades().some(t => t.tokenId === target.tokenId)) continue; // already in

          const sized = sizeOrder('direct', CONFIG.capital.totalUsd * positionPct(), market.conditionId);
          if (!sized.ok) { log('INFO', `Direct trade skipped (${sized.reason})`); continue; }

          const limit = Math.min(0.99, target.price * (1 + CONFIG.smartMoney.maxSlippage));
          const meta = { conditionId: market.conditionId, outcome: target.outcome, title: question };
          log('SIGNAL', `${modeTag()} Trend ${trend.toUpperCase()} → BUY ${target.outcome} $${sized.usd.toFixed(2)} on "${question.slice(0, 50)}"`);
          const fill = await placeOrder({ tokenId: target.tokenId, side: 'BUY', amount: sized.usd, price: limit, orderType: 'FOK' }, 'direct', meta);
          if (fill.success) {
            log('TRADE', `${modeTag()} Direct BUY ${fill.shares.toFixed(2)} ${target.outcome} @ ${fill.avgPrice.toFixed(3)}`);
            recordTrade(0, 'direct', { market: question, side: 'BUY', size: fill.shares, price: fill.avgPrice });
          } else {
            log('WARN', `${modeTag()} Direct BUY failed: ${fill.error}`);
          }
        } catch (err) {
          log('WARN', `Direct trade error: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      log('WARN', `Direct trading error: ${(err as Error).message}`);
    }
  }

  setInterval(checkTrendTrades, 5 * 60 * 1000);
  setTimeout(checkTrendTrades, 10000);
}

/**
 * Exit manager: stop-loss / take-profit / trailing / max-hold on direct trades,
 * and auto-redeem of resolved markets for every strategy the bot opened
 * (DipArb settles its own rounds through the service).
 */
async function manageExits() {
  const trades = openTrades().filter(t => t.strategy !== 'dipArb');
  if (trades.length === 0) return;

  const resolutionChecks = new Map<string, Promise<MarketResolution>>();
  for (const trade of trades) {
    try {
      // 1. Resolved market → redeem
      if (!resolutionChecks.has(trade.conditionId)) resolutionChecks.set(trade.conditionId, marketResolution(trade.conditionId));
      const resolution = await resolutionChecks.get(trade.conditionId)!;
      if (resolution.isResolved) {
        const pnl = await redeemTrade(trade);
        if (pnl !== null) {
          state.redeems++;
          log('TRADE', `${modeTag()} Redeemed ${trade.title.slice(0, 40)} (${resolution.winningOutcome} won) | realised $${pnl.toFixed(2)}`);
          recordTrade(pnl, trade.strategy === 'manual' ? 'direct' : trade.strategy, { market: trade.title, side: 'SELL', size: trade.shares, price: resolution.winningOutcome === trade.outcome.toUpperCase() ? 1 : 0 });
        }
        continue;
      }

      // 2. Exit rules on direct trades
      if (trade.strategy !== 'direct') continue;
      const price = await fetchMidPrice(trade.tokenId);
      if (price === null) continue;
      const peak = Math.max(trade.peakPrice, price);
      if (paper) paper.markToMarket(new Map([[trade.tokenId, price]]));
      else { const e = liveTrades.get(trade.tokenId); if (e) e.peakPrice = peak; }

      const reason = evaluateExit({ entryPrice: trade.entryPrice, peakPrice: peak, openedAt: trade.openedAt }, price, Date.now(), exitRules());
      if (!reason) continue;

      const limit = Math.max(0.01, price * (1 - CONFIG.smartMoney.maxSlippage));
      const fill = await placeOrder({ tokenId: trade.tokenId, side: 'SELL', amount: trade.shares, price: limit, orderType: 'FAK' }, 'direct', { conditionId: trade.conditionId, outcome: trade.outcome, title: trade.title });
      if (fill.success) {
        const pnl = fill.realizedPnl ?? (fill.avgPrice - trade.entryPrice) * fill.shares;
        log('TRADE', `${modeTag()} ${reason.toUpperCase()} on ${trade.title.slice(0, 40)}: sold ${fill.shares.toFixed(2)} @ ${fill.avgPrice.toFixed(3)} (entry ${trade.entryPrice.toFixed(3)}) | realised $${pnl.toFixed(2)}`);
        recordTrade(pnl, 'direct', { market: trade.title, side: 'SELL', size: fill.shares, price: fill.avgPrice });
      } else {
        log('WARN', `${modeTag()} ${reason} exit failed on ${trade.title.slice(0, 40)}: ${fill.error}`);
      }
    } catch (err) {
      log('WARN', `Exit manager error on ${trade.title.slice(0, 30)}: ${(err as Error).message}`);
    }
  }
  if (liveTrades.size) saveLiveTrades();
}

// ============================================================================
// WALLET, APPROVALS, PORTFOLIO
// ============================================================================

let swapService: SwapService | null = null;

async function updateBalances() {
  if (paper) { syncPaperToState(); updateDashboard(); return; }
  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;
    for (const b of balances) {
      const val = parseFloat(b.balance);
      if (b.symbol === 'MATIC' && state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      if (b.symbol === 'USDC' && state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      if (b.symbol === 'USDC_E' && state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
    }
    if (changed) updateDashboard();
  } catch { /* silent on interval */ }
}

async function setupSwap() {
  if (paper) return;
  log('SWAP', 'Setting up Wallet & Balance Monitor...');
  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);
    await updateBalances();
    log('SWAP', 'Balances:', { matic: state.maticBalance.toFixed(4), usdce: `$${state.usdcEBalance.toFixed(2)}` });
    if (state.usdcEBalance < 5) {
      log('WARN', `⚠️ Low USDC.e balance ($${state.usdcEBalance.toFixed(2)}). The bot trades USDC.e (bridged USDC) on Polygon.`);
    }
    if (state.maticBalance < CONFIG.onchain.minMatic) {
      log('WARN', `⚠️ Low MATIC (${state.maticBalance.toFixed(3)} < ${CONFIG.onchain.minMatic}): merges/redeems will fail without gas.`);
    }
    setInterval(updateBalances, 30000);
    updateDashboard();
  } catch (err) {
    log('WARN', `Balance setup error: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || paper) return;
  log('CHAIN', 'Checking on-chain approvals...');
  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;
    const onchain = new OnchainService({ privateKey: process.env.POLYMARKET_PRIVATE_KEY, rpcUrl: 'https://polygon-rpc.com' });
    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Auto-approving Exchange contracts (unlimited USDC.e allowance + CTF operator)...');
      const result = await onchain.approveAll();
      if (result.allApproved) log('CHAIN', '✅ All approvals ready');
      else {
        log('WARN', `Approval status: ${result.summary}`);
        result.erc20Approvals.forEach(r => { if (!r.success) log('WARN', `❌ ERC20 approval failed: ${r.contract} - ${r.error}`); });
        result.erc1155Approvals.forEach(r => { if (!r.success) log('WARN', `❌ ERC1155 approval failed: ${r.contract} - ${r.error}`); });
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) log('WARN', 'Missing approvals:', status.issues);
      else log('CHAIN', '✅ Approvals verified');
    }
  } catch (err) {
    log('WARN', `Onchain setup error: ${(err as Error).message}`);
  }
}

/** Positions view: live from the Data API, simulation from the paper broker (marked to market). */
async function syncPortfolio() {
  try {
    if (paper) {
      const positions = paper.getPositions();
      const prices = new Map<string, number>();
      await Promise.all(positions.map(async p => {
        const mid = await fetchMidPrice(p.tokenId);
        if (mid !== null) prices.set(p.tokenId, mid);
      }));
      paper.markToMarket(prices);
      state.positions = paper.getPositions().map(p => {
        const cur = p.lastPrice ?? p.avgCost;
        return {
          asset: p.tokenId,
          conditionId: p.conditionId,
          outcome: p.outcome,
          size: p.shares,
          avgPrice: p.avgCost,
          curPrice: cur,
          cashPnl: (cur - p.avgCost) * p.shares,
          percentPnl: p.avgCost > 0 ? ((cur - p.avgCost) / p.avgCost) * 100 : 0,
          title: p.title || p.conditionId,
          slug: p.strategy,
          marketClosed: false,
          isWinner: false,
        };
      });
      syncPaperToState();
      updateDashboard();
      return;
    }

    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    const enriched = await Promise.all(positions.map(async (pos: any) => {
      try {
        const market = await sdk.markets.getMarket(pos.conditionId);
        if (market) {
          pos.marketClosed = market.closed;
          const token = market.tokens.find((t: any) => t.tokenId === pos.asset);
          if (token) { pos.isWinner = token.winner || false; pos.curPrice = token.price || 0; }
        }
      } catch { /* keep basic data */ }
      return pos;
    }));
    let unrealized = 0;
    for (const p of enriched) {
      const entry = Number(p.avgPrice) || 0;
      const current = Number(p.curPrice) || 0;
      const size = Number(p.size) || 0;
      if (current > 0 && size > 0) unrealized += (current - entry) * size;
    }
    state.unrealizedPnL = unrealized;
    state.positions = enriched;
    updateDashboard();
  } catch (err) {
    log('WARN', `Portfolio sync error: ${(err as Error).message}`);
  }
}

// ============================================================================
// DASHBOARD CONFIG / COMMANDS
// ============================================================================

function dashboardConfig(): BotConfig {
  return {
    capital: CONFIG.capital,
    risk: CONFIG.risk,
    smartMoney: {
      enabled: CONFIG.smartMoney.enabled,
      topN: CONFIG.smartMoney.topN,
      minWinRate: CONFIG.smartMoney.minWinRate,
      minPnl: CONFIG.smartMoney.minPnl,
      minTrades: CONFIG.smartMoney.minTrades,
      customWallets: CONFIG.smartMoney.customWallets,
    },
    arbitrage: { enabled: CONFIG.arbitrage.enabled, profitThreshold: CONFIG.arbitrage.profitThreshold, autoExecute: CONFIG.arbitrage.autoExecute },
    dipArb: { enabled: CONFIG.dipArb.enabled, coins: CONFIG.dipArb.coins },
    directTrading: { enabled: CONFIG.directTrading.enabled },
    binance: { enabled: CONFIG.binance.enabled },
    dryRun: CONFIG.dryRun,
  };
}

async function switchMode(wantDryRun: boolean) {
  if (CONFIG.dryRun === wantDryRun) return;
  if (!wantDryRun && (ALLOW_LIVE_TOGGLE !== 'true' || !process.env.POLYMARKET_PRIVATE_KEY)) {
    log('ERROR', 'Refused: switching to LIVE from the dashboard is disabled. Set ALLOW_DASHBOARD_LIVE_TOGGLE=true and a private key in .env, or restart with DRY_RUN=false.');
    return;
  }
  log('WARN', `Switching to ${wantDryRun ? 'SIMULATION' : 'LIVE'} mode (requested from dashboard)...`);

  // Stop strategies on the old execution layer
  persistRisk();
  paper?.save();
  stopSmartMoney();
  if (arbService) await arbService.stop();
  await dipArb.stop();
  dipArbRounds.clear();

  CONFIG.dryRun = wantDryRun;
  if (CONFIG.dryRun) {
    setupPaperBroker();
  } else {
    // The SDK was built without CLOB credentials in simulation: initialise now
    await sdk.initialize();
    paper = null;
    state.paper = undefined;
    liveCtf = new CTFClient({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
    loadLiveTrades();
    await setupOnchain();
    await setupSwap();
  }
  loadRiskForCurrentMode();

  await setupArbitrage();
  await setupDipArb();
  if (CONFIG.smartMoney.enabled) await initializeSmartMoney();
  await syncPortfolio();

  dashboardEmitter.updateConfig(dashboardConfig());
  log('WARN', `⚠️ BOT MODE IS NOW: ${CONFIG.dryRun ? '🧪 SIMULATION' : '🔴 LIVE'}`);
}

function setupDashboardCommands() {
  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
    try {
      if (command === 'toggleDryRun') {
        await switchMode(!!(payload && payload.enabled));
        return;
      }

      if (command === 'closePosition') {
        const { tokenId, size } = payload;
        const pos = state.positions.find(p => p.asset === tokenId);
        const meta = { conditionId: pos?.conditionId || 'unknown', outcome: pos?.outcome || '?', title: pos?.title || tokenId };
        log('TRADE', `${modeTag()} Closing position: ${meta.title.slice(0, 40)} (${size} shares)`);
        const fill = await placeOrder({ tokenId, side: 'SELL', amount: Number(size), orderType: 'FAK' }, 'manual', meta);
        if (fill.success) {
          const entry = Number(pos?.avgPrice) || 0;
          const pnl = fill.realizedPnl ?? (entry > 0 ? (fill.avgPrice - entry) * fill.shares : 0);
          log('TRADE', `${modeTag()} ✅ Position closed: ${fill.shares.toFixed(2)} sh @ ${fill.avgPrice.toFixed(3)} | realised $${pnl.toFixed(2)}`);
          recordTrade(pnl, 'manual');
          await syncPortfolio();
        } else {
          log('WARN', `❌ Close failed: ${fill.error}`);
        }
        return;
      }

      if (command === 'toggleStrategy') {
        const { strategy, enabled } = payload;
        const key = strategy as keyof typeof CONFIG;
        if (!TOGGLEABLE_STRATEGIES.has(key)) { log('WARN', `Unknown strategy: ${strategy}`); return; }
        (CONFIG[key] as any).enabled = !!enabled;
        log('INFO', `⚙️ Strategy ${strategy} ${enabled ? 'ENABLED' : 'DISABLED'}`);

        if (strategy === 'dipArb') {
          if (enabled) { if (dipArb.isActive()) log('WARN', 'DipArb already running'); else await startDipArb(); }
          else { await dipArb.stop(); state.dipArb.status = 'idle'; }
        } else if (strategy === 'arbitrage') {
          if (enabled) {
            if (!arbService) log('ERROR', 'Arbitrage service not initialised. Restart the bot.');
            else if (arbService.isActive()) log('WARN', 'Arbitrage already running');
            else await startArbitrageScan(1000);
          } else if (arbService) {
            await arbService.stop();
            state.arbitrage.status = 'idle';
          }
        } else if (strategy === 'smartMoney') {
          if (enabled) await initializeSmartMoney(); else stopSmartMoney();
        } else if (strategy === 'directTrading' && enabled) {
          log('INFO', 'Direct trading will run on the next 5-minute cycle');
        }
        updateDashboard();
        dashboardEmitter.updateConfig(dashboardConfig());
        return;
      }

      if (command === 'redeemPosition') {
        const { conditionId } = payload;
        const entry = openTrades().find(t => t.conditionId === conditionId)
          ?? { tokenId: '', conditionId, strategy: 'manual' as Strategy, outcome: '?', title: conditionId, usd: 0, shares: 0, entryPrice: 0, openedAt: 0, peakPrice: 0 };
        log('CHAIN', `${modeTag()} Redeem requested for ${conditionId.slice(0, 12)}...`);
        const pnl = await redeemTrade(entry);
        if (pnl === null) log('WARN', '❌ Redeem failed');
        else { state.redeems++; log('CHAIN', `✅ Redeemed | realised $${pnl.toFixed(2)}`); recordTrade(pnl, entry.strategy === 'manual' ? 'direct' : entry.strategy); await syncPortfolio(); }
        return;
      }

      if (command === 'resetPaper') {
        if (!paper) { log('WARN', 'Not in simulation mode'); return; }
        paper.reset(); paper.save();
        risk = createRiskState(CONFIG.capital.totalUsd); persistRisk(); syncRiskToState();
        sessionTrades.length = 0;
        log('INFO', '📝 Paper account and simulation risk state reset');
        await syncPortfolio();
      }
    } catch (err) {
      log('WARN', `Command ${command} failed: ${(err as Error).message}`);
    }
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log(`║   POLYMARKET BOT v3.2 + DASHBOARD   ${CONFIG.dryRun ? '🧪 SIMULATION (paper broker)' : '🔴 LIVE TRADING          '}   ║`);
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  const dashboardPort = parseInt(process.env.DASHBOARD_PORT || '3001', 10);
  startDashboard(dashboardPort).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Dashboard port ${dashboardPort} is already in use (another bot instance?). Stop it or set DASHBOARD_PORT.`);
      process.exit(1);
    }
    throw err;
  });
  console.log(`\n🌐 Dashboard: http://localhost:${dashboardPort}\n`);

  if (!process.env.POLYMARKET_PRIVATE_KEY && !CONFIG.dryRun) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY not found in .env (required for LIVE mode)');
    process.exit(1);
  }
  if (!process.env.POLYMARKET_PRIVATE_KEY && ALLOW_LIVE_TOGGLE === 'true') {
    log('WARN', 'No private key: the dashboard LIVE toggle stays disabled');
  }

  if (CONFIG.dryRun) {
    // Simulation needs market data and the WebSocket only: no CLOB API key, and
    // no private key at all (the SDK falls back to a throwaway key for reads).
    sdk = new PolymarketSDK({ privateKey: process.env.POLYMARKET_PRIVATE_KEY });
    sdk.connect();
    try { await sdk.waitForConnection(15000); } catch (err) { log('WARN', `Realtime WebSocket not connected yet: ${(err as Error).message}`); }
    if (process.env.POLYMARKET_PRIVATE_KEY) log('INFO', `Wallet: ${sdk.tradingService.getAddress()} (not used in simulation)`);
  } else {
    sdk = await PolymarketSDK.create({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
    log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);
  }
  readOnlyCtf = new CTFClient({ privateKey: '0x' + '1'.repeat(64) });

  if (CONFIG.dryRun) {
    setupPaperBroker();
  } else {
    liveCtf = new CTFClient({ privateKey: process.env.POLYMARKET_PRIVATE_KEY! });
    loadLiveTrades();
  }
  loadRiskForCurrentMode();

  dashboardEmitter.updateConfig(dashboardConfig());
  updateDashboard();
  setupDashboardCommands();

  await setupOnchain();           // live only: approvals first
  await setupSwap();              // live only: balances
  await setupBinanceAnalysis();
  await setupArbitrage();
  await setupDipArb();
  if (CONFIG.smartMoney.enabled) await initializeSmartMoney();
  await setupDirectTrading();

  await syncPortfolio();
  setInterval(syncPortfolio, 30 * 1000);
  setInterval(() => { void manageExits(); }, 60 * 1000);
  setInterval(updateDashboard, 5000);

  const shutdown = async () => {
    console.log('\n\nShutting down...');
    persistRisk();
    paper?.save();
    saveLiveTrades();
    try {
      addSession(createSessionFromState(state.startTime, state, CONFIG, sessionTrades));
    } catch (err) {
      console.error('Could not save session history:', (err as Error).message);
    }
    stopSmartMoney();
    if (arbService) await arbService.stop();
    await dipArb.stop();
    sdk.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  log('INFO', `🚀 Bot + Dashboard running in ${CONFIG.dryRun ? 'SIMULATION' : 'LIVE'} mode. Press Ctrl+C to stop.\n`);

  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);
    const pct = positionPct();
    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.2 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Runtime:        ${runtime} minutes`);
    console.log(`  Mode:           ${CONFIG.dryRun ? '🧪 SIMULATION' : '🔴 LIVE'}`);
    console.log(`  Status:         ${state.permanentlyHalted ? '💀 HALTED' : state.isPaused ? `⏸️ PAUSED (${risk.pauseReason})` : '▶️ ACTIVE'}`);
    console.log('─'.repeat(70));
    console.log('  RISK:');
    console.log(`    Daily PnL:    $${state.dailyPnL.toFixed(2)} / -$${(CONFIG.capital.totalUsd * CONFIG.risk.dailyMaxLossPct).toFixed(2)}`);
    console.log(`    Monthly PnL:  $${state.monthlyPnL.toFixed(2)} / -$${(CONFIG.capital.totalUsd * CONFIG.risk.monthlyMaxLossPct).toFixed(2)}`);
    console.log(`    Total PnL:    $${state.totalPnL.toFixed(2)} (unrealised $${state.unrealizedPnL.toFixed(2)})`);
    console.log(`    Drawdown:     ${(state.currentDrawdown * 100).toFixed(1)}% / ${(CONFIG.risk.maxDrawdownFromPeak * 100).toFixed(0)}%`);
    console.log(`    Streak:       ${state.consecutiveWins}W / ${state.consecutiveLosses}L → next size ${(pct * 100).toFixed(2)}% ($${(CONFIG.capital.totalUsd * pct).toFixed(2)})`);
    console.log('─'.repeat(70));
    if (paper) {
      const s = paper.summary();
      console.log('  PAPER ACCOUNT:');
      console.log(`    Balance:      $${s.balance.toFixed(2)} | positions $${s.positionsValue.toFixed(2)} | equity $${s.equity.toFixed(2)}`);
      console.log(`    Realised:     $${s.realizedPnl.toFixed(2)} | gas $${s.gasSpent.toFixed(2)} | fees $${s.feesPaid.toFixed(2)} | ${s.fills} fills`);
    } else {
      console.log('  BALANCES:');
      console.log(`    MATIC:        ${state.maticBalance.toFixed(4)}`);
      console.log(`    USDC.e:       $${state.usdcEBalance.toFixed(2)}`);
    }
    console.log('─'.repeat(70));
    console.log('  STRATEGIES:');
    console.log(`    Smart Money:  ${state.smartMoneyTrades} trades | ${state.followedWallets.length} wallets`);
    console.log(`    Arbitrage:    ${state.arbTrades} trades | $${state.arbProfit.toFixed(2)}`);
    console.log(`    DipArb:       ${state.dipArbTrades} trades | ${state.activeDipArbMarket || '-'}`);
    console.log(`    Direct:       ${state.directTrades} trades | open ${openTrades().filter(t => t.strategy === 'direct').length}`);
    console.log('═'.repeat(70) + '\n');
  }

  setInterval(displayStatus, 60000);
  displayStatus();
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err);
  process.exit(1);
});
