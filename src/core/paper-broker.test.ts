import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperBroker, type PaperBook } from './paper-broker.js';
import type { MarketResolution } from '../clients/ctf-client.js';

const YES = 'tok-yes';
const NO = 'tok-no';
const COND = '0xcond';

const books: Record<string, PaperBook> = {};
let resolution: MarketResolution;
let clock = 1_000;

function broker(opts: { balance?: number; gas?: number; stateFile?: string } = {}) {
  const b = new PaperBroker(
    { initialBalance: opts.balance ?? 100, gasCostUsd: opts.gas ?? 0.1, stateFile: opts.stateFile },
    {
      fetchBook: async (tokenId) => {
        const book = books[tokenId];
        if (!book) throw new Error('no book');
        return book;
      },
      resolveTokenIds: async () => ({ yesTokenId: YES, noTokenId: NO }),
      getResolution: async () => resolution,
      now: () => clock,
    },
  );
  b.registerMarket(COND, { yesTokenId: YES, noTokenId: NO }, { title: 'Test market', strategy: 'test' });
  return b;
}

beforeEach(() => {
  books[YES] = { asks: [{ price: 0.40, size: 10 }, { price: 0.45, size: 20 }], bids: [{ price: 0.38, size: 10 }, { price: 0.35, size: 50 }] };
  books[NO] = { asks: [{ price: 0.55, size: 100 }], bids: [{ price: 0.52, size: 100 }] };
  resolution = { conditionId: COND, isResolved: false, payoutNumerators: [0, 0], payoutDenominator: 0 };
  clock = 1_000;
});

describe('market orders', () => {
  it('walks the asks and charges the real average price', async () => {
    const b = broker();
    // $4 at 0.40 fills the first level entirely (10 shares), then $2 at 0.45
    const r = await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 6, price: 0.45 });
    expect(r.success).toBe(true);
    expect(r.filledShares).toBeCloseTo(10 + 2 / 0.45);
    expect(b.getBalance()).toBeCloseTo(94);
    const pos = b.getPosition(YES)!;
    expect(pos.shares).toBeCloseTo(r.filledShares!);
    expect(pos.avgCost).toBeCloseTo(6 / r.filledShares!);
    expect(pos.strategy).toBe('test');
    expect(pos.conditionId).toBe(COND);
  });

  it('rejects a FOK buy that exceeds the depth within the limit price', async () => {
    const b = broker();
    const r = await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 6, price: 0.40, orderType: 'FOK' });
    expect(r.success).toBe(false);
    expect(r.errorMsg).toContain('FOK not filled');
    expect(b.getBalance()).toBe(100);
    expect(b.getPosition(YES)).toBeUndefined();
  });

  it('fills a FAK buy partially within the limit price', async () => {
    const b = broker();
    const r = await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 6, price: 0.40, orderType: 'FAK' });
    expect(r.success).toBe(true);
    expect(r.filledShares).toBeCloseTo(10);
    expect(r.usdc).toBeCloseTo(4);
  });

  it('applies the default slippage limit when no price is given', async () => {
    books[YES].asks = [{ price: 0.40, size: 1 }, { price: 0.60, size: 100 }];
    const b = broker();
    // best ask 0.40 → limit 0.412; only 1 share ($0.40) available → FOK fails
    const r = await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 5 });
    expect(r.success).toBe(false);
  });

  it('enforces the $1 minimum and the paper balance', async () => {
    const b = broker({ balance: 3 });
    expect((await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 0.5 })).success).toBe(false);
    const r = await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 5, price: 0.45 });
    expect(r.success).toBe(false);
    expect(r.errorMsg).toContain('insufficient paper balance');
  });

  it('sells against the bids and realises pnl on an average-cost basis', async () => {
    const b = broker();
    await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 }); // 10 shares @ 0.40
    const r = await b.createMarketOrder({ tokenId: YES, side: 'SELL', amount: 10 });
    expect(r.success).toBe(true);
    expect(r.avgPrice).toBeCloseTo(0.38);
    expect(r.realizedPnl).toBeCloseTo(-0.2);
    expect(b.getRealizedPnl()).toBeCloseTo(-0.2);
    expect(b.getBalance()).toBeCloseTo(99.8);
    expect(b.getPosition(YES)).toBeUndefined();
  });

  it('refuses to sell more than held', async () => {
    const b = broker();
    await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });
    const r = await b.createMarketOrder({ tokenId: YES, side: 'SELL', amount: 11 });
    expect(r.success).toBe(false);
    expect(r.errorMsg).toContain('only 10.00 held');
  });

  it('fails cleanly when the orderbook cannot be fetched', async () => {
    const b = broker();
    const r = await b.createMarketOrder({ tokenId: 'missing', side: 'BUY', amount: 5 });
    expect(r.success).toBe(false);
    expect(r.errorMsg).toContain('orderbook unavailable');
  });
});

describe('ctf operations', () => {
  it('merges pairs for $1 each minus gas and realises the arbitrage profit', async () => {
    const b = broker();
    await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });   // 10 @ 0.40
    await b.createMarketOrder({ tokenId: NO, side: 'BUY', amount: 5.5 });  // 10 @ 0.55
    const bal = await b.getPositionBalanceByTokenIds(COND, { yesTokenId: YES, noTokenId: NO });
    expect(parseFloat(bal.yesBalance)).toBeCloseTo(10);
    expect(parseFloat(bal.noBalance)).toBeCloseTo(10);

    const m = await b.mergeByTokenIds(COND, { yesTokenId: YES, noTokenId: NO }, '10');
    expect(m.success).toBe(true);
    // 10 pairs → $10, cost $9.50, gas $0.10 → +$0.40
    expect(b.getRealizedPnl()).toBeCloseTo(0.4);
    expect(b.getBalance()).toBeCloseTo(100 - 9.5 + 10 - 0.1);
    expect(b.getPositions()).toHaveLength(0);
    expect(b.summary().gasSpent).toBeCloseTo(0.1);
  });

  it('refuses to merge more pairs than held', async () => {
    const b = broker();
    await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });
    await expect(b.mergeByTokenIds(COND, { yesTokenId: YES, noTokenId: NO }, '5')).rejects.toThrow('insufficient pairs');
  });

  it('splits USDC into pairs with a $0.50 cost basis per side', async () => {
    const b = broker();
    const s = await b.split(COND, '20');
    expect(s.success).toBe(true);
    expect(b.getBalance()).toBeCloseTo(100 - 20 - 0.1);
    expect(b.getPosition(YES)!.shares).toBeCloseTo(20);
    expect(b.getPosition(NO)!.avgCost).toBeCloseTo(0.5);
  });

  it('redeems a resolved market at the payout and books the result', async () => {
    const b = broker();
    await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });   // 10 @ 0.40
    await b.createMarketOrder({ tokenId: NO, side: 'BUY', amount: 2.75 }); // 5 @ 0.55
    await expect(b.redeem(COND)).rejects.toThrow('not resolved');

    resolution = { conditionId: COND, isResolved: true, winningOutcome: 'YES', payoutNumerators: [1, 0], payoutDenominator: 1 };
    const r = await b.redeem(COND);
    expect(r.success).toBe(true);
    expect(parseFloat(r.usdcReceived)).toBeCloseTo(10);
    // payout 10 - cost (4 + 2.75) - gas 0.1
    expect(b.getRealizedPnl()).toBeCloseTo(3.15);
    expect(b.getPositions()).toHaveLength(0);
  });
});

describe('reporting and persistence', () => {
  it('marks positions to market and tracks the peak price', () => {
    const b = broker();
    return (async () => {
      await b.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });
      expect(b.markToMarket(new Map([[YES, 0.5]]))).toBeCloseTo(1);
      expect(b.markToMarket(new Map([[YES, 0.45]]))).toBeCloseTo(0.5);
      expect(b.getPosition(YES)!.peakPrice).toBeCloseTo(0.5);
      const s = b.summary();
      expect(s.equity).toBeCloseTo(96 + 4.5);
      expect(s.unrealizedPnl).toBeCloseTo(0.5);
    })();
  });

  it('saves and restores the whole account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'paper-'));
    try {
      const file = join(dir, 'paper.json');
      const a = broker({ stateFile: file });
      await a.createMarketOrder({ tokenId: YES, side: 'BUY', amount: 4 });
      await a.createMarketOrder({ tokenId: YES, side: 'SELL', amount: 5 });
      a.save();

      const c = new PaperBroker({ initialBalance: 100, gasCostUsd: 0.1, stateFile: file }, {
        fetchBook: async () => { throw new Error('unused'); },
        resolveTokenIds: async () => ({ yesTokenId: YES, noTokenId: NO }),
        getResolution: async () => resolution,
      });
      expect(c.load()).toBe(true);
      expect(c.getBalance()).toBeCloseTo(a.getBalance());
      expect(c.getRealizedPnl()).toBeCloseTo(a.getRealizedPnl());
      expect(c.getPosition(YES)!.shares).toBeCloseTo(5);
      expect(c.getFills()).toHaveLength(2);
      expect(c.getPosition(YES)!.title).toBe('Test market');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load returns false without a file', () => {
    expect(broker().load()).toBe(false);
  });
});
