/**
 * Bot with Dashboard - Wrapper that runs the bot with real-time monitoring UI
 * 
 * This file shows HOW to integrate the dashboard with your bot.
 * It imports the dashboard and hooks into the bot's state/logs.
 * 
 * Run with: npx tsx bot-with-dashboard.ts
 * Then open: http://localhost:5173
 */

import 'dotenv/config';
import { ethers } from 'ethers';
import {
  PolymarketSDK,
  ArbitrageService,
  SwapService,
  type SmartMoneyTrade,
  OnchainService,
} from './src/index.js';
import { CTFClient } from './src/clients/ctf-client.js';
import { startDashboard, dashboardEmitter } from './src/dashboard/index.js';
import type { BotState, BotConfig, LogLevel, DipArbSignal, SmartMoneySignal } from './src/dashboard/types.js';
import {
  applyTrade,
  createRiskState,
  evaluateRisk,
  loadRiskState,
  saveRiskState,
  type RiskConfig,
  type RiskState,
} from './src/core/risk-manager.js';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// CONFIGURATION (same as bot-config.ts)
// ============================================================================

let CONFIG = {
  capital: {
    totalUsd: parseFloat(process.env.CAPITAL_USD || '250'),
    maxPerTradePct: 0.02,  // 🔴 FIXED: Reduced from 3% to 2%
    maxPerMarketPct: 0.10,
    maxTotalExposurePct: 0.30,
    minOrderUsd: 5,
    strategyAllocation: {
      smartMoney: 0.60,
      arbitrage: 0.20,
      dipArb: 0.10,
      directTrades: 0.10,
    },
  },

  risk: {
    // Daily limits
    dailyMaxLossPct: 0.05,  // 🔴 FIXED: Reduced from 8% to 5%
    maxConsecutiveLosses: 6,
    pauseOnBreachMinutes: 60,

    // 🔴 NEW: v3.1 Multi-layer protection
    monthlyMaxLossPct: 0.15,  // 15% monthly limit
    maxDrawdownFromPeak: 0.25,  // 25% drawdown from peak
    totalMaxLossPct: 0.40,  // 40% total loss - permanent halt

    // 🔴 NEW: Dynamic position sizing
    enableDynamicSizing: true,
    minPositionPct: 0.01,  // 1% minimum
    maxPositionPct: 0.05,  // 5% maximum
    lossSizingReduction: 0.20,  // Reduce 20% per loss
    winSizingIncrease: 0.10,  // Increase 10% per win
  },

  smartMoney: {
    enabled: process.env.SMARTMONEY_ENABLED !== 'false',
    topN: 20,
    // 🔴 FIXED: Stricter criteria (v3.1)
    minWinRate: 0.60,  // Up from 0.70 to match bot-config (60%+)
    minPnl: 500,       // Up from 70 to $500
    minTrades: 30,     // Up from 15 to 30

    // 🔴 NEW: Quality filters
    minProfitFactor: 1.5,  // Total wins / total losses >= 1.5x
    minConsistencyScore: 0.7,  // Recent performance score
    maxSingleTradeExposure: 0.3,  // Max 30% of PnL from one trade
    checkLastNTrades: 10,  // Analyze last 10 trades

    sizeScale: 0.1,
    maxSizePerTrade: 15,  // Up from 10
    maxSlippage: 0.03,
    minTradeSize: 10,  // Up from 5
    delay: 500,
    customWallets: [
      '0xc2e7800b5af46e6093872b177b7a5e7f0563be51',
      '0x58c3f5d66c95d4c41b093fbdd2520e46b6c9de74',
    ] as string[],
  },

  arbitrage: {
    enabled: process.env.ARBITRAGE_ENABLED === 'true',
    // 🔴 FIXED: Higher profit threshold for gas fees
    profitThreshold: 0.01,  // Up from 0.001 to 1%
    minTradeSize: 20,  // Up from 5 to reduce gas impact
    maxTradeSize: 100,  // Up from 50
    minVolume24h: 5000,
    autoExecute: true,
    enableRebalancer: true,

    // 🔴 NEW: Gas fee accounting
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
    // 🔴 NEW: Minimum trade value
    minTradeValueUSD: 1.5,  // $1.50 minimum
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
    // 🔴 NEW: Stop-loss and take-profit
    stopLossPct: 0.15,
    takeProfitPct: 0.25,
    trailingStopPct: 0.10,
    maxHoldDays: 7,
    minRiskReward: 1.5,
  },

  dryRun: process.env.DRY_RUN !== 'false',
};

/** Switching to LIVE from the browser is opt-in: it must be enabled in .env. */
const ALLOW_LIVE_TOGGLE = process.env.ALLOW_DASHBOARD_LIVE_TOGGLE || 'false';
const TOGGLEABLE_STRATEGIES = new Set<keyof typeof CONFIG>(['smartMoney', 'arbitrage', 'dipArb', 'directTrading', 'binance']);

// ============================================================================
// STATE
// ============================================================================

const state: BotState = {
  startTime: Date.now(),
  dailyPnL: 0,
  totalPnL: 0,
  consecutiveLosses: 0,
  consecutiveWins: 0,  // 🔴 NEW
  tradesExecuted: 0,
  isPaused: false,
  pauseUntil: 0,

  // 🔴 NEW: v3.1 Risk tracking
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

// ============================================================================
// DASHBOARD-AWARE UTILITIES
// ============================================================================

function log(level: LogLevel, message: string, data?: unknown) {
  const timestamp = new Date().toISOString();
  const icons: Record<string, string> = {
    INFO: '📋', WARN: '⚠️', ERROR: '❌', TRADE: '💰', SIGNAL: '🎯',
    ARB: '🔄', WALLET: '👛', CHAIN: '⛓️', SWAP: '💱', BRIDGE: '🌉',
    KLINE: '📊', TREND: '📈',
  };

  // Console output (CLI)
  console.log(`[${timestamp}] ${icons[level] || '•'} ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));

  // Dashboard output (WebSocket)
  dashboardEmitter.log(level, message, data);
}

function updateDashboard() {
  dashboardEmitter.updateState(state);
}

// ============================================================================
// RISK MANAGEMENT (persisted, see src/core/risk-manager.ts)
// ============================================================================
//
// Risk counters are kept in `risk`, mirrored into `state` for the dashboard,
// and written to data/risk-state.<mode>.json after every change so that a
// restart cannot lift a pause or a permanent halt. Dry-run and live keep
// separate files so paper results never gate real trading.

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
  return join(__dirname, 'data', `risk-state.${dryRun ? 'dry' : 'live'}.json`);
}

let risk: RiskState = createRiskState(CONFIG.capital.totalUsd);

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

/** Load the risk state for the current mode (called at startup and on mode switch). */
function loadRiskForCurrentMode() {
  const file = riskStatePath(CONFIG.dryRun);
  const loaded = loadRiskState(file);
  if (loaded) {
    risk = loaded.state;
    const age = Math.round((Date.now() - loaded.savedAt) / 60000);
    log('INFO', `Risk state restored from ${file} (saved ${age} min ago): total PnL $${risk.totalPnL.toFixed(2)}, paused=${risk.isPaused}, halted=${risk.permanentlyHalted}`);
    if (loaded.capitalUsd !== CONFIG.capital.totalUsd) {
      log('WARN', `CAPITAL_USD changed since last run ($${loaded.capitalUsd} → $${CONFIG.capital.totalUsd}). Loss limits are computed on the new value; delete ${file} to start fresh.`);
    }
  } else {
    risk = createRiskState(CONFIG.capital.totalUsd);
    log('INFO', `No risk state found for ${CONFIG.dryRun ? 'dry-run' : 'live'} mode, starting fresh`);
  }
  syncRiskToState();
  updateDashboard();
}

function canTrade(): boolean {
  const wasPaused = risk.isPaused;
  const decision = evaluateRisk(risk, riskConfig());

  for (const message of decision.messages) {
    const level: LogLevel = decision.breach === 'total_loss' || decision.breach === 'permanent_halt'
      ? 'ERROR'
      : decision.breach ? 'WARN' : 'INFO';
    log(level, message);
  }

  if (decision.breach === 'permanent_halt') {
    // Already halted before this call - keep the log quiet (once per minute)
    if (Date.now() - lastHaltLog > 60_000) {
      log('ERROR', '🛑 Trading permanently halted - total loss limit reached');
      lastHaltLog = Date.now();
    }
  }

  if (decision.breach || decision.resumed || wasPaused !== risk.isPaused) {
    syncRiskToState();
    persistRisk();
    updateDashboard();
  } else {
    syncRiskToState();
  }

  return decision.allowed;
}
let lastHaltLog = 0;

/**
 * Record a realised trade result. Pass the real profit (or loss) in USD.
 * Pass 0 for an opening leg whose outcome is not yet known: it counts as a
 * trade but does not move PnL or win/loss streaks.
 */
function recordTrade(profit: number, strategy: string) {
  applyTrade(risk, profit);

  if (strategy === 'smartMoney') state.smartMoneyTrades++;
  else if (strategy === 'arbitrage') state.arbTrades++;
  else if (strategy === 'dipArb') state.dipArbTrades++;
  else if (strategy === 'direct') state.directTrades++;

  syncRiskToState();
  persistRisk();
  // Re-evaluate immediately so a breach pauses the bot before the next signal
  canTrade();
  updateDashboard();
}

function simulateTrade(profit: number, strategy: string, description: string) {
  if (!CONFIG.dryRun || !state.paper) return;

  state.paper.trades++;
  state.paper.pnl += profit;
  state.paper.balance += profit;

  // Log as a special SIMULATION event
  log('TRADE', `[SIMULATION] ${description} | Est. Profit: $${profit.toFixed(2)}`);

  // Update main PnL so the user sees movement on the dashboard (as requested)
  recordTrade(profit, strategy);
}

// ============================================================================
// ============================================================================
// STRATEGIES (simplified versions - copy full implementations from bot-config.ts)
// ============================================================================

let arbService: ArbitrageService | null = null;
const simulatedArbAt = new Map<string, number>();
const SIMULATED_ARB_COOLDOWN_MS = 60_000;
let isSmartMoneyInitialized = false;
let isSmartMoneyInitializing = false;

async function setupSmartMoney(sdk: PolymarketSDK) {
  if (CONFIG.smartMoney.enabled) {
    initializeSmartMoney(sdk);
  }
}

async function initializeSmartMoney(sdk: PolymarketSDK) {
  if (isSmartMoneyInitialized || isSmartMoneyInitializing) return;
  isSmartMoneyInitializing = true;

  log('WALLET', 'Setting up Smart Money with quality filtering...');

  const qualified: string[] = [];

  if (CONFIG.smartMoney.customWallets?.length > 0) {
    for (const wallet of CONFIG.smartMoney.customWallets) {
      qualified.push(wallet);
      log('WALLET', `⭐ Custom wallet added: ${wallet.slice(0, 10)}...`);
    }
  }

  try {
    const leaderboard = await sdk.wallets.getLeaderboardByPeriod('week', CONFIG.smartMoney.topN * 2, 'pnl');

    for (const entry of leaderboard) {
      // Check if disabled mid-process to abort early
      if (!CONFIG.smartMoney.enabled && qualified.length === 0) break;

      if (qualified.length >= 10) break; // User limit: Max 10 qualified wallets
      if (qualified.includes(entry.address)) continue;

      const profile = await sdk.wallets.getWalletProfile(entry.address);
      if (!profile) continue;

      const winRate = (profile as any).winRate ?? 0;
      const pnl = entry.pnl ?? 0;
      const trades = profile.tradeCount ?? 0;

      if (winRate >= CONFIG.smartMoney.minWinRate &&
        pnl >= CONFIG.smartMoney.minPnl &&
        trades >= CONFIG.smartMoney.minTrades) {
        qualified.push(entry.address);
        log('WALLET', `✅ Qualified: ${entry.address.slice(0, 10)}... (WR:${(winRate * 100).toFixed(0)}% PnL:$${pnl.toFixed(0)} T:${trades})`);
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
    // Subscribe to smart money trades. The address filter is essential:
    // without it every trade on Polymarket would be reported as a signal.
    sdk.smartMoney.subscribeSmartMoneyTrades(
      async (trade: SmartMoneyTrade) => {
        if (!CONFIG.smartMoney.enabled) return;

        // Add to smart money signals for dashboard
        const signal: SmartMoneySignal = {
          id: `sm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          timestamp: new Date().toISOString(),
          wallet: trade.traderAddress,
          market: trade.marketSlug || 'Unknown',
          side: trade.side as 'BUY' | 'SELL',
          size: trade.size,
          price: trade.price,
        };
        state.smartMoneySignals.unshift(signal);
        if (state.smartMoneySignals.length > 50) {
          state.smartMoneySignals = state.smartMoneySignals.slice(0, 50);
        }

        log('SIGNAL', `Copy trade signal from ${trade.traderAddress.slice(0, 10)}...`, {
          market: trade.marketSlug?.slice(0, 50),
          side: trade.side,
          size: trade.size,
          price: trade.price,
        });
        updateDashboard();

        if (!canTrade()) return;

        const plan = planCopyTrade(trade);
        if (!plan) return;

        if (CONFIG.dryRun) {
          simulateTrade(0, 'smartMoney', `Smart Money Copy: ${trade.side} $${plan.usdcAmount.toFixed(2)} (${plan.shares.toFixed(2)} sh) @ ≤${plan.limitPrice.toFixed(3)} on ${trade.marketSlug || trade.conditionId}`);
          return;
        }

        try {
          if (CONFIG.smartMoney.delay > 0) {
            await new Promise(r => setTimeout(r, CONFIG.smartMoney.delay));
          }
          const res = await sdk.tradingService.createMarketOrder({
            tokenId: plan.tokenId,
            side: trade.side,
            amount: plan.usdcAmount,
            price: plan.limitPrice,
            orderType: 'FOK',
          });
          if (res.success) {
            // Opening a position: realised PnL is unknown until it is closed,
            // so record the trade with 0 profit (does not touch streaks).
            recordTrade(0, 'smartMoney');
            log('TRADE', `✅ Copied ${trade.side} $${plan.usdcAmount.toFixed(2)} from ${trade.traderAddress.slice(0, 8)}... (order ${res.orderId || 'n/a'})`);
          } else {
            log('WARN', `❌ Copy trade failed: ${res.errorMsg || 'unknown error'}`);
          }
        } catch (err) {
          log('WARN', `❌ Copy trade error: ${(err as Error).message}`);
        }
      },
      { filterAddresses: qualified }
    );
  }
  isSmartMoneyInitialized = true;
  isSmartMoneyInitializing = false;
}

/**
 * Size a copy trade from the leader's trade. Mirrors SmartMoneyService.startAutoCopyTrading
 * but runs after the risk gate. Returns null when the trade should be skipped.
 */
function planCopyTrade(trade: SmartMoneyTrade): { tokenId: string; usdcAmount: number; shares: number; limitPrice: number } | null {
  const cfg = CONFIG.smartMoney;
  if (!trade.tokenId || !(trade.price > 0) || !(trade.size > 0)) return null;

  const leaderValue = trade.size * trade.price;
  if (leaderValue < cfg.minTradeSize) return null;

  let usdcAmount = leaderValue * cfg.sizeScale;
  usdcAmount = Math.min(usdcAmount, cfg.maxSizePerTrade);
  // Hard cap from capital config, whichever is lower
  usdcAmount = Math.min(usdcAmount, CONFIG.capital.totalUsd * CONFIG.capital.maxPerTradePct);
  if (usdcAmount < 1) return null; // Polymarket minimum order

  const limitPrice = trade.side === 'BUY'
    ? Math.min(0.99, trade.price * (1 + cfg.maxSlippage))
    : Math.max(0.01, trade.price * (1 - cfg.maxSlippage));

  return { tokenId: trade.tokenId, usdcAmount, shares: usdcAmount / trade.price, limitPrice };
}



async function setupArbitrage(_sdk: PolymarketSDK) {
  // Always setup service and listeners
  log('ARB', 'Setting up Arbitrage Service...');

  state.arbitrage.status = 'idle';
  updateDashboard();

  // Create standalone ArbitrageService (not using SDK wrapper)
  arbService = new ArbitrageService({
    privateKey: CONFIG.dryRun ? undefined : process.env.POLYMARKET_PRIVATE_KEY,
    profitThreshold: CONFIG.arbitrage.profitThreshold,
    minTradeSize: CONFIG.arbitrage.minTradeSize,
    maxTradeSize: CONFIG.arbitrage.maxTradeSize,
    autoExecute: !CONFIG.dryRun && CONFIG.arbitrage.autoExecute,
    enableRebalancer: !CONFIG.dryRun && CONFIG.arbitrage.enableRebalancer,
    enableLogging: true,
  });

  arbService.on('opportunity', (opp) => {
    state.activeArbMarket = opp.market?.name || 'scanning';
    state.arbitrage.opportunitiesFound++;
    state.arbitrage.lastOpportunity = {
      timestamp: new Date().toISOString(),
      type: opp.type as 'long' | 'short',
      profitPct: opp.profitPercent / 100,
      market: opp.market?.name || 'Unknown',
    };
    log('ARB', `Opportunity: ${opp.type.toUpperCase()} +${opp.profitPercent.toFixed(2)}%`);

    // SIMULATION HOOK
    // 'opportunity' fires on every orderbook update, so the same opportunity
    // would be "earned" dozens of times. Count it once per market/type per
    // execution cooldown, and only if the risk gate allows a trade.
    if (CONFIG.dryRun && opp.profitPercent > 0) {
      const key = `${state.arbitrage.currentMarket || opp.market?.name || 'unknown'}:${opp.type}`;
      const last = simulatedArbAt.get(key) || 0;
      if (Date.now() - last >= SIMULATED_ARB_COOLDOWN_MS && canTrade()) {
        simulatedArbAt.set(key, Date.now());
        const size = Math.min(opp.recommendedSize || CONFIG.arbitrage.minTradeSize, CONFIG.arbitrage.maxTradeSize);
        const estimatedProfit = size * (opp.profitPercent / 100);
        simulateTrade(estimatedProfit, 'arbitrage', `Arb ${opp.type} ${opp.market?.name || ''} size $${size.toFixed(2)} (estimate, not a fill)`);
      }
    }

    updateDashboard();
  });

  arbService.on('execution', (result) => {
    if (result.success) {
      state.arbProfit += result.profit || 0;
      recordTrade(result.profit || 0, 'arbitrage');
      log('TRADE', `Arb trade executed: +$${(result.profit || 0).toFixed(2)} profit`);
    }
  });

  // Scan for arbitrage opportunities ONLY if enabled
  if (CONFIG.arbitrage.enabled) {
    state.arbitrage.status = 'scanning';
    try {
      const results = await arbService.scanMarkets(
        { minVolume24h: CONFIG.arbitrage.minVolume24h },
        CONFIG.arbitrage.profitThreshold
      );
      state.arbitrage.marketsScanned = results.length;
      const opps = results.filter(r => r.arbType !== 'none');

      if (opps.length > 0) {
        state.activeArbMarket = opps[0].market.name;
        state.arbitrage.currentMarket = opps[0].market.name;
        state.arbitrage.status = 'monitoring';
        await arbService.start(opps[0].market);
        log('ARB', `Started monitoring: ${opps[0].market.name}`);
      } else {
        state.arbitrage.status = 'idle';
        log('ARB', 'No arbitrage opportunities found, will keep scanning...');
      }
      updateDashboard();
    } catch (err) {
      state.arbitrage.status = 'idle';
      log('WARN', `Arbitrage scan error: ${(err as Error).message}`);
      updateDashboard();
    }
  }
}

/** Per-round cost tracking so DipArb can report realised PnL on merge / exit. */
const dipArbRounds = new Map<string, { leg1Cost: number; leg2Cost: number; shares: number }>();

async function setupDipArb(sdk: PolymarketSDK) {
  // Always setup listeners provided by this function
  log('ARB', 'Setting up DipArb Service...');

  // Configure the DipArb service
  sdk.dipArb.updateConfig({
    shares: CONFIG.dipArb.shares,
    sumTarget: CONFIG.dipArb.sumTarget,
    autoExecute: !CONFIG.dryRun,
    debug: true,
  });

  // Event handlers - listen to orderbookUpdate for live orderbook data
  sdk.dipArb.on('orderbookUpdate', (update: {
    upPrice: number;
    downPrice: number;
    sum: number;
  }) => {
    state.dipArb.upPrice = update.upPrice;
    state.dipArb.downPrice = update.downPrice;
    state.dipArb.sum = update.sum;
    updateDashboard();
  });

  // Listen to 'started' event to sync market details immediately
  sdk.dipArb.on('started', (market: any) => {
    log('ARB', `DipArb Service Started Monitoring: ${market.name}`);
    state.activeDipArbMarket = market.name;
    state.dipArb.marketName = market.name;
    state.dipArb.underlying = market.underlying || 'ETH';
    state.dipArb.duration = `${market.durationMinutes}m`;
    state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
    state.dipArb.status = 'active'; // Force status update
    updateDashboard();

    // Also notify dashboard specifically about status change
    dashboardEmitter.updateStrategyStatus('dipArb', 'active', market.name);
  });

  // Listen to newRound for round changes
  sdk.dipArb.on('newRound', (round: { roundId: string; priceToBeat: number }) => {
    log('ARB', `New round: ${round.roundId}, Price to Beat: ${round.priceToBeat}`);
    updateDashboard();
  });

  // Signal handler - extract data from DipArbLeg1Signal or DipArbLeg2Signal
  sdk.dipArb.on('signal', (s: {
    type: 'leg1' | 'leg2';
    dipSide?: string;
    hedgeSide?: string;
    currentPrice: number;
    source?: string;
    dropPercent?: number;
  }) => {
    const side = s.dipSide || s.hedgeSide || 'UP';
    const signal: DipArbSignal = {
      id: `da-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      type: s.type as DipArbSignal['type'],
      side: side as 'UP' | 'DOWN',
      price: s.currentPrice || 0,
      change: s.dropPercent ? -s.dropPercent * 100 : 0,
    };
    state.dipArb.lastSignal = signal;
    state.dipArb.signals.unshift(signal);
    if (state.dipArb.signals.length > 20) {
      state.dipArb.signals = state.dipArb.signals.slice(0, 20);
    }
    log('SIGNAL', `DipArb: ${s.type} ${side} @ ${s.currentPrice?.toFixed(3)}`);

    // NO SIMULATION on signal anymore - signals are not trades!
    // We only want to track actual executions (which will fire the 'execution' event)

    updateDashboard();
  });

  sdk.dipArb.on('execution', (r: {
    success: boolean;
    leg: 'leg1' | 'leg2' | 'merge' | 'exit';
    roundId: string;
    side?: string;
    price?: number;
    shares?: number;
    error?: string;
  }) => {
    if (!r.success) {
      log('WARN', `DipArb Execution Failed (${r.leg}): ${r.error || 'Unknown error'}`);
      return;
    }

    const priceStr = r.price ? r.price.toFixed(3) : '??';
    const sharesStr = r.shares ? r.shares.toFixed(1) : '??';
    const market = state.activeDipArbMarket || 'unknown-market';
    const round = dipArbRounds.get(r.roundId) || { leg1Cost: 0, leg2Cost: 0, shares: 0 };

    switch (r.leg) {
      case 'leg1':
        round.leg1Cost = (r.price || 0) * (r.shares || 0);
        round.shares = r.shares || 0;
        dipArbRounds.set(r.roundId, round);
        log('TRADE', `OPEN ${r.side} | ${sharesStr} shares @ $${priceStr} | ${market}`);
        recordTrade(0, 'dipArb'); // position opened, outcome unknown
        break;
      case 'leg2':
        round.leg2Cost = (r.price || 0) * (r.shares || 0);
        dipArbRounds.set(r.roundId, round);
        log('TRADE', `HEDGE ${r.side} | ${sharesStr} shares @ $${priceStr} | pair cost $${(round.leg1Cost + round.leg2Cost).toFixed(2)}`);
        recordTrade(0, 'dipArb');
        break;
      case 'exit': {
        // Timeout exit: leg1 sold at ~market price. Realised = proceeds - leg1 cost.
        const proceeds = (r.price || 0) * (r.shares || 0);
        const profit = round.leg1Cost > 0 ? proceeds - round.leg1Cost : 0;
        dipArbRounds.delete(r.roundId);
        log('TRADE', `CLOSE ${r.side} (Timeout Exit) | ${sharesStr} shares @ $${priceStr} | realised $${profit.toFixed(2)}`);
        recordTrade(profit, 'dipArb');
        break;
      }
      case 'merge': {
        // Each merged pair pays exactly $1. Realised = pairs - (leg1 + leg2 cost).
        const pairs = r.shares || round.shares;
        const cost = round.leg1Cost + round.leg2Cost;
        const profit = cost > 0 ? pairs - cost : 0;
        dipArbRounds.delete(r.roundId);
        log('TRADE', `MERGE | ${pairs.toFixed(1)} pairs → $${pairs.toFixed(2)} | cost $${cost.toFixed(2)} | realised $${profit.toFixed(2)} | ${market}`);
        state.merges++;
        recordTrade(profit, 'dipArb');
        break;
      }
      default:
        log('TRADE', `DipArb ${r.leg}: ${r.side} @ ${priceStr}`);
        recordTrade(0, 'dipArb');
    }
  });

  sdk.dipArb.on('rotate', (e: { newMarket: string }) => {
    state.activeDipArbMarket = e.newMarket;
    state.dipArb.marketName = e.newMarket;
    log('ARB', `DipArb rotated to ${e.newMarket}`);
    updateDashboard();
  });

  // Enable auto-rotate if configured
  if (CONFIG.dipArb.autoRotate) {
    sdk.dipArb.enableAutoRotate({
      enabled: true,
      underlyings: ['ETH', 'BTC', 'SOL'],
      duration: '15m',
      settleStrategy: 'redeem',
      redeemWaitMinutes: 5,
    });
  }

  // Find and start monitoring a market
  if (CONFIG.dipArb.enabled) {
    try {
      const market = await sdk.dipArb.findAndStart({ coin: 'ETH', preferDuration: '15m' });
      if (market) {
        state.activeDipArbMarket = market.name;
        state.dipArb.marketName = market.name;
        state.dipArb.underlying = market.underlying || 'ETH';
        state.dipArb.duration = `${market.durationMinutes}m`;
        // endTime is a Date object, convert to timestamp
        state.dipArb.endTime = market.endTime ? new Date(market.endTime).getTime() : null;
        state.dipArb.status = 'active'; // Force status update
        log('ARB', `DipArb started: ${market.name}`);
      } else {
        log('WARN', 'No DipArb markets found');
      }
      updateDashboard();
    } catch (err) {
      log('WARN', `DipArb setup error: ${(err as Error).message}`);
    }
  }
}

let swapService: SwapService | null = null;

async function updateBalances() {
  if (CONFIG.dryRun) {
    // SIMULATION: Mock balances
    // Base 10,000 + whatever PnL we've made in this session
    state.usdcEBalance = 10000 + state.totalPnL;
    state.maticBalance = 100;

    // Only verify once/log sparsely
    if (Math.random() < 0.05) { // Occasional log
      // no-op
    }
    updateDashboard();
    return;
  }

  if (!swapService) return;
  try {
    const balances = await swapService.getBalances();
    let changed = false;

    // Parse balances from TokenBalance array
    for (const b of balances) {
      if (b.symbol === 'MATIC') {
        const val = parseFloat(b.balance);
        if (state.maticBalance !== val) { state.maticBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC') {
        const val = parseFloat(b.balance);
        if (state.usdcBalance !== val) { state.usdcBalance = val; changed = true; }
      }
      if (b.symbol === 'USDC_E') {
        const val = parseFloat(b.balance);
        if (state.usdcEBalance !== val) { state.usdcEBalance = val; changed = true; }
      }
    }

    if (changed) {
      updateDashboard();
      // Optional: Log only on significant changes or debug
      // log('SWAP', 'Balances updated');
    }
  } catch (err) {
    // Silent fail on interval to avoid log spam
  }
}

async function setupSwap() {
  log('SWAP', 'Setting up Wallet & Balance Monitor...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    // Create SwapService with signer
    const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
    const signer = new ethers.Wallet(process.env.POLYMARKET_PRIVATE_KEY, provider);
    swapService = new SwapService(signer);

    // Initial fetch
    await updateBalances();

    log('SWAP', 'Balances:', {
      matic: state.maticBalance.toFixed(4),
      usdce: `$${state.usdcEBalance.toFixed(2)}`,
    });

    // Check for low USDC.e (Bridged) balance
    if (!CONFIG.dryRun && state.usdcEBalance < 5) {
      log('WARN', `⚠️ Low USDC.e balance ($${state.usdcEBalance.toFixed(2)}). Bot requires USDC.e (Bridged USDC) on Polygon.`);
      log('WARN', `ℹ️ Please deposit USDC.e or swap your Native USDC to USDC.e manually.`);
    }

    // Poll balances every 30 seconds
    setInterval(updateBalances, 30000);

    updateDashboard();
  } catch (err) {
    log('WARN', `Balance setup error: ${(err as Error).message}`);
  }
}

async function setupOnchain() {
  if (!CONFIG.onchain.enabled || CONFIG.dryRun) return;
  log('CHAIN', 'Checking on-chain approvals...');

  try {
    if (!process.env.POLYMARKET_PRIVATE_KEY) return;

    const onchain = new OnchainService({
      privateKey: process.env.POLYMARKET_PRIVATE_KEY,
      rpcUrl: 'https://polygon-rpc.com',
    });

    if (CONFIG.onchain.autoApprove) {
      log('CHAIN', 'Auto-approving Proxy and Exchange...');
      const result = await onchain.approveAll();

      if (result.allApproved) {
        log('CHAIN', '✅ All approvals ready');
      } else {
        log('WARN', `Approval status: ${result.summary}`);
        // Log individual failures
        result.erc20Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC20 Approval failed: ${r.contract} - ${r.error}`);
        });
        result.erc1155Approvals.forEach(r => {
          if (!r.success) log('WARN', `❌ ERC1155 Approval failed: ${r.contract} - ${r.error}`);
        });
      }
    } else {
      const status = await onchain.checkAllowances();
      if (!status.tradingReady) {
        log('WARN', 'Missing approvals:', status.issues);
        log('WARN', 'Enable onchain.autoApprove=true to fix automatically');
      } else {
        log('CHAIN', '✅ Approvals verified');
      }
    }
  } catch (err) {
    log('WARN', `Onchain setup error: ${(err as Error).message}`);
  }
}

async function setupBinanceAnalysis(sdk: PolymarketSDK) {
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
  await updateTrends();
  setInterval(updateTrends, 5 * 60 * 1000);
}

const CRYPTO_MARKET_RE = /\b(btc|bitcoin|eth|ethereum|ether|sol|solana)\b/i;

async function setupDirectTrading(sdk: PolymarketSDK) {
  log('INFO', 'Direct trading setup complete - waiting for toggle');

  if (CONFIG.directTrading.enabled) {
    if (CONFIG.dryRun) {
      log('INFO', 'Direct trading enabled (simulation mode)');
    } else {
      log('INFO', 'Direct trading enabled - will place orders based on trend analysis');
    }
  }

  async function checkTrendTrades() {
    if (!CONFIG.directTrading.enabled) return;
    if (!canTrade()) return;

    try {
      const trendingMarkets = await sdk.gammaApi.getTrendingMarkets(5);

      for (const market of trendingMarkets) {
        if (!market.conditionId) continue;

        try {
          const fullMarket = await sdk.getMarket(market.conditionId);
          const yesToken = fullMarket.tokens.find(t => t.outcome === 'Yes');
          const noToken = fullMarket.tokens.find(t => t.outcome === 'No');

          if (!yesToken || !noToken) continue;

          // Whole-word match only: the previous pattern matched "method",
          // "whether", "resolve", "solar"... and bought unrelated markets.
          const question = market.question || '';
          const isCryptoMarket = CRYPTO_MARKET_RE.test(question);

          if (isCryptoMarket && CONFIG.directTrading.trendFollowing) {
            let trend: 'up' | 'down' | 'neutral' = 'neutral';
            if (/\b(btc|bitcoin)\b/i.test(question)) trend = state.btcTrend;
            else if (/\b(eth|ethereum|ether)\b/i.test(question)) trend = state.ethTrend;
            else if (/\b(sol|solana)\b/i.test(question)) trend = state.solTrend;

            if (trend !== 'neutral') {
              // Strategy: 
              // UP -> Expect YES to win -> Buy YES
              // DOWN -> Expect YES to lose -> Buy NO
              const targetToken = trend === 'up' ? yesToken : noToken;
              const side = 'BUY'; // We always BUY the outcome we believe in
              const price = targetToken.price;

              if (CONFIG.dryRun) {
                // Simulate the trade in DRY RUN mode
                simulateTrade(0, 'direct', `Trend signal: ${market.question?.slice(0, 40)}... → ${trend.toUpperCase()} (Buy ${targetToken.outcome}) @ ${price.toFixed(2)}`);
                state.directTrades = (state.directTrades ?? 0) + 1;
                updateDashboard();
              } else {
                // Live Mode Execution
                const amountUsdc = 5; // Fixed small size for testing ($5)

                log('SIGNAL', `Executing Trend Trade: ${trend.toUpperCase()} on ${market.question?.slice(0, 30)}...`);

                sdk.tradingService.createMarketOrder({
                  tokenId: targetToken.tokenId,
                  side: 'BUY',
                  amount: amountUsdc
                }).then(res => {
                  if (res.success) {
                    log('TRADE', `✅ Direct Trade: Bought $${amountUsdc} of ${targetToken.outcome} @ ~${price.toFixed(2)}`);
                    recordTrade(0, 'direct');
                  } else {
                    log('WARN', `❌ Direct Trade failed: ${res.errorMsg}`);
                  }
                });
              }
            }
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      log('WARN', `Direct trading error: ${(err as Error).message}`);
    }
  }

  // Check every 5 minutes
  setInterval(checkTrendTrades, 5 * 60 * 1000);
  // Initial check after 10 seconds (let trends stabilize)
  setTimeout(checkTrendTrades, 10000);
}

async function setupPortfolioManager(sdk: PolymarketSDK) {
  log('INFO', 'Starting Portfolio Manager...');

  // Initial Sync
  try {
    const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());
    state.positions = positions;
    log('WALLET', `Synced ${positions.length} existing positions.`);
    updateDashboard();
  } catch (err: any) {
    log('WARN', `Portfolio Sync failed: ${err.message}`);
  }

  // Periodic Position Sync (Every 30s)
  setInterval(async () => {
    try {
      const positions = await sdk.wallets.getWalletPositions(sdk.tradingService.getAddress());

      // Enrich positions with market data (to check if won or lost)
      const enrichedPositions = await Promise.all(positions.map(async (pos: any) => {
        try {
          // Use cached market data if available
          const market = await sdk.markets.getMarket(pos.conditionId);
          if (market) {
            pos.marketClosed = market.closed;

            // Enrich with current price for PnL
            // Try to find the token in the market outcomes
            const token = market.tokens.find((t: any) => t.tokenId === pos.asset);

            if (token) {
              pos.isWinner = token.winner || false;
              // Store current price for frontend
              pos.curPrice = token.price || 0;
            }

            // If market is closed but winner info is missing/false, assume lost unless proven otherwise
            if (market.closed && !pos.isWinner) {
              // Double check if ANY token won (if market resolved)
            }
          }
        } catch (e) {
          // Ignore market fetch errors, keep basic pos data
        }
        return pos;
      }));

      // Calculate Unrealized PnL
      let unrealized = 0;
      for (const p of enrichedPositions) {
        const entry = Number(p.avgPrice) || 0;
        const current = Number(p.curPrice) || Number(p.msg_price) || 0;
        const size = Number(p.size) || 0;

        if (current > 0 && size > 0) {
          unrealized += (current - entry) * size;
        }
      }
      state.unrealizedPnL = unrealized;

      // Update Total PnL display to include Unrealized? 
      // User requested "P&L total is still not updating".
      // Usually Total = Realized + Unrealized.
      // But we keep them separate in state, let frontend decide how to show.

      state.positions = enrichedPositions;
      updateDashboard();
    } catch (err: any) {
      log('WARN', `Portfolio sync error: ${err.message}`);
    }
  }, 30 * 1000);
}

async function main() {
  console.clear();
  console.log('╔════════════════════════════════════════════════════════════════════╗');
  console.log('║          POLYMARKET BOT v3.0 + DASHBOARD                           ║');
  console.log('╚════════════════════════════════════════════════════════════════════╝\n');

  // Start Dashboard Server
  startDashboard(3001);
  console.log('\n🌐 Dashboard: http://localhost:3001\n');

  if (!process.env.POLYMARKET_PRIVATE_KEY) {
    log('ERROR', 'POLYMARKET_PRIVATE_KEY not found');
    process.exit(1);
  }

  // Send config to dashboard
  const dashboardConfig: BotConfig = {
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
    arbitrage: {
      enabled: CONFIG.arbitrage.enabled,
      profitThreshold: CONFIG.arbitrage.profitThreshold,
      autoExecute: CONFIG.arbitrage.autoExecute,
    },
    dipArb: {
      enabled: CONFIG.dipArb.enabled,
      coins: CONFIG.dipArb.coins,
    },
    directTrading: {
      enabled: CONFIG.directTrading.enabled,
    },
    binance: {
      enabled: CONFIG.binance.enabled,
    },
    dryRun: CONFIG.dryRun,
  };
  dashboardEmitter.updateConfig(dashboardConfig);
  dashboardEmitter.updateState(state);

  log('INFO', 'Configuration', {
    binance: CONFIG.binance.enabled,
  });

  // Handle Dashboard Commands
  dashboardEmitter.on('command', async (cmd: { command: string; payload: any }) => {
    if (cmd.command === 'toggleDryRun') {
      // payload.enabled is the desired value of CONFIG.dryRun
      const wantDryRun = !!(cmd.payload && cmd.payload.enabled);
      if (CONFIG.dryRun !== wantDryRun) {
        log('INFO', `Switching to ${wantDryRun ? 'DRY RUN' : 'LIVE'} mode... (Requested by user)`);

        if (!wantDryRun && ALLOW_LIVE_TOGGLE !== 'true') {
          log('ERROR', 'Refused: switching to LIVE from the dashboard is disabled. Set ALLOW_DASHBOARD_LIVE_TOGGLE=true in .env, or restart the bot with DRY_RUN=false.');
          return;
        }

        // Persist the risk state of the mode we are leaving, then load the other one
        persistRisk();
        CONFIG.dryRun = wantDryRun;
        loadRiskForCurrentMode();

        // Update State paper wallet
        if (CONFIG.dryRun && !state.paper) {
          state.paper = {
            balance: CONFIG.capital.totalUsd,
            initialBalance: CONFIG.capital.totalUsd,
            pnl: 0,
            trades: 0,
            totalVolume: 0,
          };
        }

        // Re-configure Services

        // 0. Going live: make sure approvals and balance monitoring exist
        if (!CONFIG.dryRun) {
          await setupOnchain();
          if (!swapService) await setupSwap();
          await updateBalances();
        }

        // 1. Arbitrage Service (Needs restart to update signer/sim mode)
        if (arbService) {
          // Update internal flags if possible without full restart?
          // ArbitrageService takes readonly config in constructor. Better to re-create.
          await arbService.stop();
          // Re-run setup
          await setupArbitrage(sdk);
        }

        // 2. DipArb (Update config)
        sdk.dipArb.updateConfig({
          autoExecute: !CONFIG.dryRun, // Live = autoExecute true (if config enabled)
        });

        // Emit new config to dashboard
        const newDashboardConfig: BotConfig = {
          capital: CONFIG.capital,
          risk: CONFIG.risk,
          smartMoney: { ...CONFIG.smartMoney },
          arbitrage: { ...CONFIG.arbitrage },
          dipArb: { ...CONFIG.dipArb },
          directTrading: { ...CONFIG.directTrading },
          binance: { ...CONFIG.binance },
          dryRun: CONFIG.dryRun,
        };
        dashboardEmitter.updateConfig(newDashboardConfig);

        log('WARN', `⚠️ BOT MODE CHANGED TO: ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
      }
    }
  });

  // Restore persisted risk counters (pauses and permanent halts survive restarts)
  loadRiskForCurrentMode();

  // Initialize Paper Wallet if Dry Run
  if (CONFIG.dryRun) {
    state.paper = {
      balance: CONFIG.capital.totalUsd,
      initialBalance: CONFIG.capital.totalUsd,
      pnl: 0,
      trades: 0,
      totalVolume: 0,
    };
    log('INFO', '📝 Paper Trading Activated: Simulating trades with $250 initial capital');
    updateDashboard();
  }

  const sdk = await PolymarketSDK.create({
    privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  });

  log('INFO', `Wallet: ${sdk.tradingService.getAddress()}`);

  // Setup all services
  await setupOnchain(); // MUST BE FIRST (Approvals)
  await setupSwap();
  await setupBinanceAnalysis(sdk);
  await setupSmartMoney(sdk);
  await setupArbitrage(sdk);
  await setupDipArb(sdk);

  // Periodic state update
  setInterval(() => {
    updateDashboard();
  }, 5000);

  // Setup Direct Trading
  await setupDirectTrading(sdk);

  // Setup Portfolio Manager (Persistence)
  await setupPortfolioManager(sdk);

  // Listen for commands from dashboard
  dashboardEmitter.on('command', async ({ command, payload }: { command: string; payload: any }) => {
    if (command === 'closePosition') {
      const { tokenId, size } = payload;
      log('TRADE', `Closing position: ${tokenId} (${size} shares)`);

      if (CONFIG.dryRun) {
        log('TRADE', `[SIMULATION] Would sell ${size} shares of ${tokenId}`);
        return;
      }

      try {
        // Estimate PnL before closing (using cached data)
        const position = state.positions.find(p => p.asset === tokenId);
        let estimatedPnL = 0;
        if (position) {
          const entryPrice = Number(position.avgPrice) || 0;
          // Use current market price if available, otherwise assume break-even or roughly current avg
          // Ideally we'd have the live mid-price. 'curPrice' might be in position if enriched.
          const exitPrice = Number((position as any).curPrice) || Number(position.msg_price) || 0;

          if (exitPrice > 0) {
            estimatedPnL = (exitPrice - entryPrice) * size;
          }
        }

        const res = await sdk.tradingService.createMarketOrder({
          tokenId,
          side: 'SELL',
          amount: size,
        });

        if (res.success) {
          log('TRADE', `✅ Position closed: ${size} shares sold`);
          recordTrade(estimatedPnL, 'manual');
          log('INFO', `Realized PnL (Est): $${estimatedPnL.toFixed(2)}`);
        } else {
          log('WARN', `❌ Close failed: ${res.errorMsg}`);
        }
      } catch (err: any) {
        log('WARN', `❌ Close error: ${err.message}`);
      }
    }

    if (command === 'toggleStrategy') {
      const { strategy, enabled } = payload;
      const strategyName = strategy as keyof typeof CONFIG;

      // Only real strategies can be toggled from the UI (not onchain, capital, risk...)
      if (TOGGLEABLE_STRATEGIES.has(strategyName) && typeof (CONFIG[strategyName] as any).enabled !== 'undefined') {
        (CONFIG[strategyName] as any).enabled = !!enabled;
        log('INFO', `⚙️ Strategy ${strategy} ${enabled ? 'ENABLED' : 'DISABLED'}`);

        // Actively Start/Stop Services based on toggle
        try {
          if (strategy === 'dipArb') {
            if (enabled) {
              if (sdk.dipArb.isActive()) {
                log('WARN', `DipArb is already running.`);
              } else {
                log('INFO', `Starting DipArb Service (Scanning for markets)...`);
                await sdk.dipArb.findAndStart();
              }
            } else {
              log('INFO', `Stopping DipArb Service...`);
              await sdk.dipArb.stop();
            }
          } else if (strategy === 'arbitrage') {
            if (enabled) {
              if (arbService) {
                // Update config
                arbService.updateConfig({
                  profitThreshold: CONFIG.arbitrage.profitThreshold,
                  autoExecute: CONFIG.arbitrage.autoExecute,
                });

                if (arbService.isActive()) {
                  log('WARN', `Arbitrage Service is already running.`);
                } else {
                  log('INFO', `Starting Arbitrage Service...`);

                  // Try to scan and start a market if possible
                  try {
                    const results = await arbService.scanMarkets({ minVolume24h: 1000 }, CONFIG.arbitrage.profitThreshold);
                    const best = results.find(r => r.arbType !== 'none') || results[0]; // Pick best or just first to monitor

                    if (best) {
                      await arbService.start(best.market);
                      state.activeArbMarket = best.market.name;
                      state.arbitrage.status = 'monitoring';
                      log('ARB', `Auto-started monitoring: ${best.market.name}`);
                      updateDashboard();
                    } else {
                      state.arbitrage.status = 'idle';
                      log('WARN', 'Arbitrage Service started but no markets found. Will keep scanning in background if configured.');
                      updateDashboard();
                    }
                  } catch (e) {
                    state.arbitrage.status = 'idle';
                    log('WARN', `Arbitrage auto-start failed: ${(e as Error).message}`);
                    updateDashboard();
                  }
                }
              } else {
                log('ERROR', 'Arbitrage Service not initialized. Restart bot.');
              }
            } else {
              log('INFO', `Stopping Arbitrage Service...`);
              if (arbService) {
                await arbService.stop();
                state.arbitrage.status = 'idle';
                updateDashboard();
              }
            }
          } else if (strategy === 'smartMoney') {
            if (enabled) {
              log('INFO', `Initializing Smart Money...`);
              // Call the lazy initializer we created
              initializeSmartMoney(sdk);
            } else {
              log('INFO', `Smart Money monitoring disabled.`);
            }
          } else if (strategy === 'directTrading') {
            if (enabled) {
              log('INFO', `Triggering Direct Trading analysis...`);
              // We can't easily reach the inner function checkTrendTrades from here because it's scoped inside setupDirectTrading.
              // However, checkTrendTrades runs on an interval and checks the config flag. 
              // By enabling the flag, the NEXT interval will pick it up.
              // To be immediate, we'd need to expose it, but simplified "Wait for next cycle" is acceptable or we can just log.
              log('INFO', `Direct Trading will run on next cycle (within 5 min).`);
            }
          }
        } catch (err: any) {
          log('WARN', `Failed to toggle service: ${err.message}`);
        }

        // Broadcast updated config to dashboard
        const dashboardConfig: BotConfig = {
          // ... (rest of config mapping)
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
          arbitrage: {
            enabled: CONFIG.arbitrage.enabled,
            profitThreshold: CONFIG.arbitrage.profitThreshold,
            autoExecute: CONFIG.arbitrage.autoExecute,
          },
          dipArb: {
            enabled: CONFIG.dipArb.enabled,
            coins: CONFIG.dipArb.coins,
          },
          directTrading: {
            enabled: CONFIG.directTrading.enabled,
          },
          binance: {
            enabled: CONFIG.binance.enabled,
          },
          dryRun: CONFIG.dryRun,
        };
        dashboardEmitter.updateConfig(dashboardConfig);
      } else {
        log('WARN', `Unknown strategy: ${strategy}`);
      }
    }

    if (command === 'redeemPosition') {
      const { conditionId } = payload;
      log('CHAIN', `Redeem requested for: ${conditionId}`);

      if (CONFIG.dryRun) {
        log('CHAIN', `[SIMULATION] Would redeem position ${conditionId}`);
        return;
      }

      try {
        // Create CTFClient instance for on-chain redemption
        const ctfClient = new CTFClient({
          privateKey: process.env.POLYMARKET_PRIVATE_KEY!,
        });

        // 1. Fetch market details to get Token IDs (required for Polymarket CLOB redemption)
        // We use the Gamma API (via sdk.markets or sdk.gammaApi)
        log('CHAIN', `Fetching market details for condition ${conditionId}...`);
        const market = await sdk.markets.getMarket(conditionId);

        if (!market || !market.tokens || market.tokens.length < 2) {
          log('WARN', `❌ Redeem failed: Valid market not found for condition ${conditionId}`);
          return;
        }

        const tokenIds = {
          yesTokenId: market.tokens[0].tokenId,
          noTokenId: market.tokens[1].tokenId,
        };

        log('CHAIN', `Found market: ${market.question} (Tokens: ${tokenIds.yesTokenId.slice(0, 10)}... / ${tokenIds.noTokenId.slice(0, 10)}...)`);

        // 2. Redeem using Polymarket Token IDs
        const result = await ctfClient.redeemByTokenIds(conditionId, tokenIds);

        if (result.success) {
          log('CHAIN', `✅ Redeemed! ${result.tokensRedeemed} tokens → ${result.usdcReceived} USDC`);
          log('CHAIN', `   Tx: ${result.txHash}`);
        } else {
          log('WARN', `❌ Redeem failed`);
        }
      } catch (err: any) {
        log('WARN', `❌ Redeem error: ${err.message}`);
      }
    }
  });

  process.on('SIGINT', async () => {
    console.log('\n\nShutting down...');
    persistRisk();
    if (arbService) await arbService.stop();
    await sdk.dipArb.stop();
    sdk.stop();
    process.exit(0);
  });

  log('INFO', '🚀 Bot + Dashboard running! Press Ctrl+C to stop.\n');

  // Status Display Loop
  function displayStatus() {
    const runtime = Math.round((Date.now() - state.startTime) / 1000 / 60);

    console.log('\n' + '═'.repeat(70));
    console.log('              POLYMARKET BOT v3.0 STATUS');
    console.log('═'.repeat(70));
    console.log(`  Runtime:        ${runtime} minutes`);
    console.log(`  Mode:           ${CONFIG.dryRun ? '🧪 DRY RUN' : '🔴 LIVE'}`);
    console.log(`  Status:         ${state.isPaused ? '⏸️ PAUSED' : '▶️ ACTIVE'}`);
    console.log('─'.repeat(70));
    console.log('  BALANCES:');
    console.log(`    MATIC:        ${state.maticBalance.toFixed(4)}`);
    console.log(`    USDC:         $${state.usdcBalance.toFixed(2)}`);
    console.log(`    USDC.e:       $${state.usdcEBalance.toFixed(2)}`);
    console.log('─'.repeat(70));
    console.log('  STRATEGIES:');
    console.log(`    Smart Money:  ${state.smartMoneyTrades} trades | ${state.followedWallets.length} wallets`);
    console.log(`    Arbitrage:    ${state.arbTrades} trades`);
    console.log(`    DipArb:       ${state.dipArbTrades} trades`);
    console.log('═'.repeat(70) + '\n');
  }

  setInterval(displayStatus, 60000);
  displayStatus(); // Initial call
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  console.error(err);
  process.exit(1);
});
