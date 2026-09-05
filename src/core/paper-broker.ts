/**
 * Paper Broker - simulated execution against real orderbooks.
 *
 * Implements the subset of TradingService and CTFClient that the strategy
 * services (DipArbService, ArbitrageService) and the bot call, so that dry-run
 * mode runs exactly the same code paths as live mode. The only difference is
 * where the fill comes from:
 *
 * - Market orders walk the real CLOB orderbook (fetched through `deps.fetchBook`)
 *   level by level, honour the limit price, and fail on insufficient depth
 *   (FOK) exactly like the exchange would.
 * - Split / merge / redeem move shares and USDC in the paper account and charge
 *   the configured gas cost.
 * - Every fill is recorded with its realised PnL (average-cost basis), so the
 *   bot can feed the risk manager with real numbers.
 *
 * Nothing here touches the network except `deps` callbacks supplied by the bot.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { dirname } from 'path';
import type { MarketOrderParams, OrderResult } from '../services/trading-service.js';
import type {
  MarketResolution,
  MergeResult,
  PositionBalance,
  RedeemResult,
  SplitResult,
  TokenIds,
} from '../clients/ctf-client.js';

export interface BookLevel { price: number; size: number }
export interface PaperBook { bids: BookLevel[]; asks: BookLevel[] }

export interface PaperBrokerConfig {
  initialBalance: number;
  /** USD charged for each on-chain operation (split, merge, redeem) */
  gasCostUsd: number;
  /** Taker fee as a fraction of notional (Polymarket charges 0 on most markets) */
  feeRate?: number;
  /** Max slippage from best price when the caller gives no limit price */
  defaultSlippage?: number;
  /** Polymarket minimum order value in USDC */
  minOrderUsd?: number;
  stateFile?: string;
}

export interface PaperBrokerDeps {
  fetchBook(tokenId: string): Promise<PaperBook>;
  resolveTokenIds(conditionId: string): Promise<TokenIds>;
  getResolution(conditionId: string): Promise<MarketResolution>;
  now?: () => number;
}

export interface TokenMeta {
  conditionId: string;
  outcome: string;
  title?: string;
  strategy?: string;
}

export interface PaperPosition extends TokenMeta {
  tokenId: string;
  shares: number;
  /** Average cost per share */
  avgCost: number;
  openedAt: number;
  /** Highest mark seen since entry (for trailing stops) */
  peakPrice: number;
  /** Last mark-to-market price */
  lastPrice?: number;
}

export type PaperFillKind = 'BUY' | 'SELL' | 'SPLIT' | 'MERGE' | 'REDEEM';

export interface PaperFill {
  id: string;
  timestamp: number;
  kind: PaperFillKind;
  tokenId?: string;
  conditionId: string;
  outcome?: string;
  strategy?: string;
  shares: number;
  avgPrice: number;
  /** USDC moved (negative = paid out of the account) */
  usdc: number;
  fee: number;
  gas: number;
  /** Realised PnL of this fill (0 for opening fills and splits) */
  realizedPnl: number;
}

export interface PaperOrderResult extends OrderResult {
  filledShares?: number;
  avgPrice?: number;
  usdc?: number;
  realizedPnl?: number;
}

export interface PaperSummary {
  balance: number;
  initialBalance: number;
  positionsValue: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  gasSpent: number;
  feesPaid: number;
  fills: number;
}

interface PersistedPaperState {
  version: number;
  savedAt: number;
  balance: number;
  initialBalance: number;
  realizedPnl: number;
  gasSpent: number;
  feesPaid: number;
  positions: PaperPosition[];
  fills: PaperFill[];
  tokenMeta: Record<string, TokenMeta>;
}

const STATE_VERSION = 1;
const MAX_FILLS = 1000;
const EPS = 1e-9;

export class PaperBroker {
  private balance: number;
  private readonly initialBalance: number;
  private realizedPnl = 0;
  private gasSpent = 0;
  private feesPaid = 0;
  private positions = new Map<string, PaperPosition>();
  private fills: PaperFill[] = [];
  private tokenMeta = new Map<string, TokenMeta>();
  private readonly feeRate: number;
  private readonly defaultSlippage: number;
  private readonly minOrderUsd: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(private readonly config: PaperBrokerConfig, private readonly deps: PaperBrokerDeps) {
    this.balance = config.initialBalance;
    this.initialBalance = config.initialBalance;
    this.feeRate = config.feeRate ?? 0;
    this.defaultSlippage = config.defaultSlippage ?? 0.03;
    this.minOrderUsd = config.minOrderUsd ?? 1;
    this.now = deps.now ?? (() => Date.now());
  }

  // ===== Metadata =====

  registerToken(tokenId: string, meta: TokenMeta): void {
    const existing = this.tokenMeta.get(tokenId);
    this.tokenMeta.set(tokenId, { ...existing, ...meta });
    const pos = this.positions.get(tokenId);
    if (pos) Object.assign(pos, meta);
  }

  registerMarket(conditionId: string, tokenIds: TokenIds, extra: { title?: string; strategy?: string; outcomes?: [string, string] } = {}): void {
    const [yes, no] = extra.outcomes ?? ['YES', 'NO'];
    this.registerToken(tokenIds.yesTokenId, { conditionId, outcome: yes, title: extra.title, strategy: extra.strategy });
    this.registerToken(tokenIds.noTokenId, { conditionId, outcome: no, title: extra.title, strategy: extra.strategy });
  }

  // ===== TradingService / CTFClient-compatible surface =====

  async initialize(): Promise<void> { /* nothing to do */ }

  getAddress(): string {
    return 'paper-account';
  }

  async createMarketOrder(params: MarketOrderParams & { strategy?: string; conditionId?: string }): Promise<PaperOrderResult> {
    const orderType = params.orderType ?? 'FOK';
    if (!(params.amount > 0)) return { success: false, errorMsg: 'amount must be positive' };

    let book: PaperBook;
    try {
      book = await this.deps.fetchBook(params.tokenId);
    } catch (err) {
      return { success: false, errorMsg: `orderbook unavailable: ${(err as Error).message}` };
    }

    const meta = this.tokenMeta.get(params.tokenId);
    const conditionId = params.conditionId ?? meta?.conditionId ?? 'unknown';
    const strategy = params.strategy ?? meta?.strategy;

    if (params.side === 'BUY') {
      if (params.amount < this.minOrderUsd) {
        return { success: false, errorMsg: `Order amount ($${params.amount.toFixed(2)}) is below Polymarket minimum ($${this.minOrderUsd})` };
      }
      const asks = [...book.asks].filter(l => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price);
      if (asks.length === 0) return { success: false, errorMsg: 'no asks in orderbook' };
      const limit = params.price ?? asks[0].price * (1 + this.defaultSlippage);

      let remainingUsd = params.amount;
      let shares = 0;
      let spent = 0;
      for (const level of asks) {
        if (level.price > limit + EPS) break;
        const levelUsd = level.price * level.size;
        const take = Math.min(remainingUsd, levelUsd);
        shares += take / level.price;
        spent += take;
        remainingUsd -= take;
        if (remainingUsd <= EPS) break;
      }

      if (remainingUsd > EPS) {
        if (orderType === 'FOK' || shares <= 0) {
          return { success: false, errorMsg: `FOK not filled: only $${spent.toFixed(2)} of $${params.amount.toFixed(2)} available at ≤ ${limit.toFixed(4)}` };
        }
      }

      const fee = spent * this.feeRate;
      if (spent + fee > this.balance + EPS) {
        return { success: false, errorMsg: `insufficient paper balance: have $${this.balance.toFixed(2)}, need $${(spent + fee).toFixed(2)}` };
      }

      this.balance -= spent + fee;
      this.feesPaid += fee;
      this.addShares(params.tokenId, shares, spent + fee, { conditionId, outcome: meta?.outcome ?? '?', title: meta?.title, strategy });
      const fill = this.recordFill({
        kind: 'BUY', tokenId: params.tokenId, conditionId, outcome: meta?.outcome, strategy,
        shares, avgPrice, usdc: -(spent + fee), fee, gas: 0, realizedPnl: 0,
      });
      return { success: true, orderId: fill.id, filledShares: shares, avgPrice, usdc: spent, realizedPnl: 0 };
    }

    // SELL: amount is a number of shares
    const pos = this.positions.get(params.tokenId);
    if (!pos || pos.shares <= EPS) return { success: false, errorMsg: 'no position to sell' };
    const wanted = Math.min(params.amount, pos.shares);
    if (params.amount > pos.shares + 1e-6) {
      return { success: false, errorMsg: `cannot sell ${params.amount.toFixed(2)} shares, only ${pos.shares.toFixed(2)} held` };
    }

    const bids = [...book.bids].filter(l => l.price > 0 && l.size > 0).sort((a, b) => b.price - a.price);
    if (bids.length === 0) return { success: false, errorMsg: 'no bids in orderbook' };
    const limit = params.price ?? bids[0].price * (1 - this.defaultSlippage);

    let remaining = wanted;
    let sold = 0;
    let proceeds = 0;
    for (const level of bids) {
      if (level.price < limit - EPS) break;
      const take = Math.min(remaining, level.size);
      sold += take;
      proceeds += take * level.price;
      remaining -= take;
      if (remaining <= EPS) break;
    }

    if (remaining > EPS) {
      if (orderType === 'FOK' || sold <= 0) {
        return { success: false, errorMsg: `FOK not filled: only ${sold.toFixed(2)} of ${wanted.toFixed(2)} shares bid at ≥ ${limit.toFixed(4)}` };
      }
    }
    if (proceeds < this.minOrderUsd) {
      return { success: false, errorMsg: `Order value ($${proceeds.toFixed(2)}) is below Polymarket minimum ($${this.minOrderUsd})` };
    }

    const fee = proceeds * this.feeRate;
    const costBasis = pos.avgCost * sold;
    const realizedPnl = proceeds - fee - costBasis;
    this.balance += proceeds - fee;
    this.feesPaid += fee;
    this.realizedPnl += realizedPnl;
    this.removeShares(params.tokenId, sold);
    const avgPrice = proceeds / sold;
    const fill = this.recordFill({
      kind: 'SELL', tokenId: params.tokenId, conditionId: pos.conditionId, outcome: pos.outcome, strategy: strategy ?? pos.strategy,
      shares: sold, avgPrice, usdc: proceeds - fee, fee, gas: 0, realizedPnl,
    });
    return { success: true, orderId: fill.id, filledShares: sold, avgPrice, usdc: proceeds, realizedPnl };
  }

  // ===== CTFClient-compatible surface =====

  async getUsdcBalance(): Promise<string> {
    return this.balance.toFixed(6);
  }

  async getMarketResolution(conditionId: string): Promise<MarketResolution> {
    return this.deps.getResolution(conditionId);
  }

  async getPositionBalanceByTokenIds(conditionId: string, tokenIds: TokenIds): Promise<PositionBalance> {
    return {
      conditionId,
      yesBalance: (this.positions.get(tokenIds.yesTokenId)?.shares ?? 0).toFixed(6),
      noBalance: (this.positions.get(tokenIds.noTokenId)?.shares ?? 0).toFixed(6),
      yesPositionId: tokenIds.yesTokenId,
      noPositionId: tokenIds.noTokenId,
    };
  }

  async split(conditionId: string, amount: string): Promise<SplitResult> {
    const tokenIds = await this.deps.resolveTokenIds(conditionId);
    const usd = parseFloat(amount);
    if (!(usd > 0)) throw new Error('split amount must be positive');
    const gas = this.config.gasCostUsd;
    if (usd + gas > this.balance + EPS) throw new Error(`insufficient paper balance for split: have $${this.balance.toFixed(2)}, need $${(usd + gas).toFixed(2)}`);

    this.balance -= usd + gas;
    this.gasSpent += gas;
    // Cost basis: each pair costs $1 → $0.50 per side
    this.addShares(tokenIds.yesTokenId, usd, usd / 2, this.metaFor(tokenIds.yesTokenId, conditionId, 'YES'));
    this.addShares(tokenIds.noTokenId, usd, usd / 2, this.metaFor(tokenIds.noTokenId, conditionId, 'NO'));
    const fill = this.recordFill({ kind: 'SPLIT', conditionId, strategy: this.tokenMeta.get(tokenIds.yesTokenId)?.strategy, shares: usd, avgPrice: 1, usdc: -(usd + gas), fee: 0, gas, realizedPnl: -gas });
    this.realizedPnl -= gas;
    return { success: true, txHash: fill.id, amount, yesTokens: amount, noTokens: amount };
  }

  async merge(conditionId: string, amount: string): Promise<MergeResult> {
    const tokenIds = await this.deps.resolveTokenIds(conditionId);
    return this.mergeByTokenIds(conditionId, tokenIds, amount);
  }

  async mergeByTokenIds(conditionId: string, tokenIds: TokenIds, amount: string): Promise<MergeResult> {
    const pairs = parseFloat(amount);
    if (!(pairs > 0)) throw new Error('merge amount must be positive');
    const yes = this.positions.get(tokenIds.yesTokenId);
    const no = this.positions.get(tokenIds.noTokenId);
    const held = Math.min(yes?.shares ?? 0, no?.shares ?? 0);
    if (held + 1e-6 < pairs) {
      throw new Error(`insufficient pairs to merge: have ${held.toFixed(4)}, need ${pairs.toFixed(4)}`);
    }

    const gas = this.config.gasCostUsd;
    const costBasis = yes!.avgCost * pairs + no!.avgCost * pairs;
    const realizedPnl = pairs - costBasis - gas;
    this.balance += pairs - gas;
    this.gasSpent += gas;
    this.realizedPnl += realizedPnl;
    this.removeShares(tokenIds.yesTokenId, pairs);
    this.removeShares(tokenIds.noTokenId, pairs);
    const fill = this.recordFill({ kind: 'MERGE', conditionId, strategy: yes!.strategy ?? no!.strategy, shares: pairs, avgPrice: 1, usdc: pairs - gas, fee: 0, gas, realizedPnl });
    return { success: true, txHash: fill.id, amount, usdcReceived: pairs.toFixed(6) };
  }

  async redeem(conditionId: string, outcome?: string): Promise<RedeemResult> {
    const tokenIds = await this.deps.resolveTokenIds(conditionId);
    return this.redeemByTokenIds(conditionId, tokenIds, outcome);
  }

  async redeemByTokenIds(conditionId: string, tokenIds: TokenIds, outcome?: string): Promise<RedeemResult> {
    const resolution = await this.deps.getResolution(conditionId);
    if (!resolution.isResolved) throw new Error('Market is not resolved yet');
    const denominator = resolution.payoutDenominator || 1;
    const yesPayout = resolution.payoutNumerators[0] / denominator;
    const noPayout = resolution.payoutNumerators[1] / denominator;

    const yes = this.positions.get(tokenIds.yesTokenId);
    const no = this.positions.get(tokenIds.noTokenId);
    const yesShares = yes?.shares ?? 0;
    const noShares = no?.shares ?? 0;
    if (yesShares <= EPS && noShares <= EPS) throw new Error('no position to redeem');

    const gas = this.config.gasCostUsd;
    const payout = yesShares * yesPayout + noShares * noPayout;
    const costBasis = (yes?.avgCost ?? 0) * yesShares + (no?.avgCost ?? 0) * noShares;
    const realizedPnl = payout - costBasis - gas;
    this.balance += payout - gas;
    this.gasSpent += gas;
    this.realizedPnl += realizedPnl;
    if (yesShares > 0) this.removeShares(tokenIds.yesTokenId, yesShares);
    if (noShares > 0) this.removeShares(tokenIds.noTokenId, noShares);
    const winner = outcome ?? resolution.winningOutcome ?? 'SPLIT';
    const fill = this.recordFill({ kind: 'REDEEM', conditionId, outcome: winner, strategy: yes?.strategy ?? no?.strategy, shares: yesShares + noShares, avgPrice: payout / (yesShares + noShares), usdc: payout - gas, fee: 0, gas, realizedPnl });
    return { success: true, txHash: fill.id, outcome: winner, tokensRedeemed: (yesShares + noShares).toFixed(6), usdcReceived: payout.toFixed(6) };
  }

  // ===== Reporting =====

  /** Update last / peak prices and return the total unrealised PnL. */
  markToMarket(prices: Map<string, number>): number {
    let unrealized = 0;
    for (const pos of this.positions.values()) {
      const price = prices.get(pos.tokenId);
      if (price === undefined || !(price >= 0)) continue;
      pos.lastPrice = price;
      if (price > pos.peakPrice) pos.peakPrice = price;
      unrealized += (price - pos.avgCost) * pos.shares;
    }
    return unrealized;
  }

  getPositions(): PaperPosition[] {
    return [...this.positions.values()].map(p => ({ ...p }));
  }

  getPosition(tokenId: string): PaperPosition | undefined {
    const p = this.positions.get(tokenId);
    return p ? { ...p } : undefined;
  }

  getFills(limit = 100): PaperFill[] {
    return this.fills.slice(-limit).reverse();
  }

  getRealizedPnl(): number {
    return this.realizedPnl;
  }

  getBalance(): number {
    return this.balance;
  }

  summary(): PaperSummary {
    let positionsValue = 0;
    let unrealized = 0;
    for (const p of this.positions.values()) {
      const mark = p.lastPrice ?? p.avgCost;
      positionsValue += mark * p.shares;
      unrealized += (mark - p.avgCost) * p.shares;
    }
    return {
      balance: this.balance,
      initialBalance: this.initialBalance,
      positionsValue,
      equity: this.balance + positionsValue,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      gasSpent: this.gasSpent,
      feesPaid: this.feesPaid,
      fills: this.fills.length,
    };
  }

  // ===== Persistence =====

  save(): void {
    if (!this.config.stateFile) return;
    const payload: PersistedPaperState = {
      version: STATE_VERSION,
      savedAt: this.now(),
      balance: this.balance,
      initialBalance: this.initialBalance,
      realizedPnl: this.realizedPnl,
      gasSpent: this.gasSpent,
      feesPaid: this.feesPaid,
      positions: this.getPositions(),
      fills: this.fills.slice(-MAX_FILLS),
      tokenMeta: Object.fromEntries(this.tokenMeta),
    };
    const dir = dirname(this.config.stateFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.config.stateFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, this.config.stateFile);
  }

  /** Restore a previous paper session. Returns false when nothing was loaded. */
  load(): boolean {
    if (!this.config.stateFile || !existsSync(this.config.stateFile)) return false;
    try {
      const raw = JSON.parse(readFileSync(this.config.stateFile, 'utf-8')) as Partial<PersistedPaperState>;
      if (raw.version !== STATE_VERSION || typeof raw.balance !== 'number') return false;
      this.balance = raw.balance;
      this.realizedPnl = raw.realizedPnl ?? 0;
      this.gasSpent = raw.gasSpent ?? 0;
      this.feesPaid = raw.feesPaid ?? 0;
      this.positions = new Map((raw.positions ?? []).map(p => [p.tokenId, p]));
      this.fills = raw.fills ?? [];
      this.tokenMeta = new Map(Object.entries(raw.tokenMeta ?? {}));
      this.seq = this.fills.length;
      return true;
    } catch {
      return false;
    }
  }

  /** Reset the account to its initial balance (keeps token metadata). */
  reset(): void {
    this.balance = this.initialBalance;
    this.realizedPnl = 0;
    this.gasSpent = 0;
    this.feesPaid = 0;
    this.positions.clear();
    this.fills = [];
    this.seq = 0;
  }

  // ===== Internals =====

  private metaFor(tokenId: string, conditionId: string, fallbackOutcome: string): TokenMeta {
    const meta = this.tokenMeta.get(tokenId);
    return { conditionId, outcome: meta?.outcome ?? fallbackOutcome, title: meta?.title, strategy: meta?.strategy };
  }

  private addShares(tokenId: string, shares: number, cost: number, meta: TokenMeta): void {
    const existing = this.positions.get(tokenId);
    if (existing) {
      const totalCost = existing.avgCost * existing.shares + cost;
      existing.shares += shares;
      existing.avgCost = totalCost / existing.shares;
      if (meta.strategy && !existing.strategy) existing.strategy = meta.strategy;
      return;
    }
    const avgCost = cost / shares;
    this.positions.set(tokenId, {
      tokenId,
      ...meta,
      shares,
      avgCost,
      openedAt: this.now(),
      peakPrice: avgCost,
    });
  }

  private removeShares(tokenId: string, shares: number): void {
    const pos = this.positions.get(tokenId);
    if (!pos) return;
    pos.shares -= shares;
    if (pos.shares <= 1e-6) this.positions.delete(tokenId);
  }

  private recordFill(fill: Omit<PaperFill, 'id' | 'timestamp'>): PaperFill {
    const full: PaperFill = { id: `paper-${this.now()}-${++this.seq}`, timestamp: this.now(), ...fill };
    this.fills.push(full);
    if (this.fills.length > MAX_FILLS) this.fills = this.fills.slice(-MAX_FILLS);
    return full;
  }
}
