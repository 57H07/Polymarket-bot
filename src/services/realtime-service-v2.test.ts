import { describe, it, expect } from 'vitest';
import { RealtimeServiceV2 } from './realtime-service-v2.js';
import type { OrderbookSnapshot } from './realtime-service-v2.js';
import type { PriceUpdate } from '../core/types.js';

/**
 * calculateDerivedPrice is private; these drive it directly because it encodes
 * Polymarket's quoting rule and is the one piece of pricing logic in the
 * service. The one-sided expectations are pinned to real observations: for a
 * market quoted 0.9995/0.0005 by the Gamma API, the CLOB book was
 * bid 0.9990 with no asks / no bids with ask 0.0010.
 */
type WithPrivates = {
  calculateDerivedPrice(assetId: string, book: OrderbookSnapshot): PriceUpdate | null;
  handleActivityMessage(type: string, payload: Record<string, unknown>, timestamp: number): void;
  lastTradeCache: Map<string, { assetId: string; price: number; side: string; size: number; timestamp: number }>;
};

// Cast through unknown: the private members make a plain intersection
// collapse to never.
function service(config?: ConstructorParameters<typeof RealtimeServiceV2>[0]): WithPrivates {
  return new RealtimeServiceV2(config) as unknown as WithPrivates;
}

function book(
  bids: Array<[number, number]>,
  asks: Array<[number, number]>
): OrderbookSnapshot {
  return {
    tokenId: 'token-a',
    assetId: 'token-a',
    market: '0xmarket',
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    timestamp: 1_750_000_000_000,
    tickSize: '0.01',
    minOrderSize: '1',
    hash: '0xhash',
  };
}

describe('calculateDerivedPrice', () => {
  it('uses the midpoint on a tight two-sided book', () => {
    const s = service();
    const price = s.calculateDerivedPrice('token-a', book([[0.28, 27]], [[0.29, 58]]));
    expect(price).not.toBeNull();
    expect(price!.midpoint).toBeCloseTo(0.285);
    expect(price!.spread).toBeCloseTo(0.01);
    expect(price!.price).toBeCloseTo(0.285);
  });

  it('falls back to the last trade when the spread is wide', () => {
    const s = service();
    s.lastTradeCache.set('token-a', {
      assetId: 'token-a', price: 0.42, side: 'BUY', size: 10, timestamp: 1,
    });
    const price = s.calculateDerivedPrice('token-a', book([[0.20, 5]], [[0.60, 5]]));
    expect(price!.spread).toBeCloseTo(0.40);
    expect(price!.price).toBeCloseTo(0.42);
  });

  it('quotes a bids-only book against the upper bound of 1', () => {
    const s = service();
    // Observed live: bid 0.9990, no asks -> Gamma quoted 0.9995.
    const price = s.calculateDerivedPrice('token-a', book([[0.999, 727594]], []));
    expect(price).not.toBeNull();
    expect(price!.price).toBeCloseTo(0.9995);
    expect(price!.midpoint).toBeCloseTo(0.9995);
    expect(price!.spread).toBeCloseTo(0.001);
  });

  it('quotes an asks-only book against the lower bound of 0', () => {
    const s = service();
    // Observed live: no bids, ask 0.0010 -> Gamma quoted 0.0005.
    const price = s.calculateDerivedPrice('token-a', book([], [[0.001, 727594]]));
    expect(price).not.toBeNull();
    expect(price!.price).toBeCloseTo(0.0005);
    expect(price!.midpoint).toBeCloseTo(0.0005);
    expect(price!.spread).toBeCloseTo(0.001);
  });

  it('does not invent a price for a book with a far one-sided quote', () => {
    const s = service();
    // Bid 0.30 with no asks: the implied spread (0.70) is wide, so the last
    // trade wins rather than a meaningless 0.65 midpoint.
    s.lastTradeCache.set('token-a', {
      assetId: 'token-a', price: 0.31, side: 'SELL', size: 4, timestamp: 1,
    });
    const price = s.calculateDerivedPrice('token-a', book([[0.30, 100]], []));
    expect(price!.price).toBeCloseTo(0.31);
  });

  it('returns null only when both sides are empty', () => {
    const s = service();
    expect(s.calculateDerivedPrice('token-a', book([], []))).toBeNull();
  });
});


/**
 * The activity feed delivers each trade on both the `trades` and
 * `orders_matched` types, and subscribeActivity subscribes to both. Before
 * deduplication this fired every copy-trading signal twice: a one-hour
 * simulation bought 6 of 14 markets twice, at identical price and size,
 * 117-477ms apart, and burned the exposure budget at double rate.
 */
describe('activity deduplication', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    asset: 'token-a',
    conditionId: '0xcond',
    slug: 'epl-eve-mun-first-half-total-1pt5',
    outcome: 'Over',
    price: 0.38,
    side: 'BUY',
    size: 396.7,
    timestamp: 1_788_691_393,
    transactionHash: '0xtx1',
    proxyWallet: '0x821dab05',
    ...over,
  });

  function collect(s: RealtimeServiceV2) {
    const seen: unknown[] = [];
    s.on('activityTrade', (t) => seen.push(t));
    return seen;
  }

  it('emits the same trade once when it arrives on both types', () => {
    const s = service();
    const seen = collect(s as unknown as RealtimeServiceV2);
    (s as WithPrivates).handleActivityMessage('trades', payload(), 1);
    (s as WithPrivates).handleActivityMessage('orders_matched', payload(), 1);
    expect(seen).toHaveLength(1);
  });

  it('keeps distinct fills that share a transaction hash', () => {
    const s = service();
    const seen = collect(s as unknown as RealtimeServiceV2);
    // One transaction can match several orders - those are real, separate fills.
    (s as WithPrivates).handleActivityMessage('trades', payload(), 1);
    (s as WithPrivates).handleActivityMessage('trades', payload({ price: 0.39 }), 1);
    (s as WithPrivates).handleActivityMessage('trades', payload({ asset: 'token-b' }), 1);
    expect(seen).toHaveLength(3);
  });

  it('keeps trades by different traders that share a transaction hash', () => {
    const s = service();
    const seen = collect(s as unknown as RealtimeServiceV2);
    // Observed live: one transaction filling several makers, same side, size
    // and price. Dropping either of these would lose a real copy signal.
    (s as WithPrivates).handleActivityMessage('trades', payload({ proxyWallet: '0xaaa' }), 1);
    (s as WithPrivates).handleActivityMessage('trades', payload({ proxyWallet: '0xbbb' }), 1);
    expect(seen).toHaveLength(2);
  });

  it('keeps repeated trades by one trader under different hashes', () => {
    const s = service();
    const seen = collect(s as unknown as RealtimeServiceV2);
    // Observed live: one wallet repeating the same size/price many times.
    (s as WithPrivates).handleActivityMessage('trades', payload({ transactionHash: '0xtx1' }), 1);
    (s as WithPrivates).handleActivityMessage('trades', payload({ transactionHash: '0xtx2' }), 1);
    expect(seen).toHaveLength(2);
  });

  it('falls back to the event timestamp when there is no tx hash', () => {
    const s = service();
    const seen = collect(s as unknown as RealtimeServiceV2);
    (s as WithPrivates).handleActivityMessage('trades', payload({ transactionHash: '' }), 1);
    (s as WithPrivates).handleActivityMessage('orders_matched', payload({ transactionHash: '' }), 1);
    expect(seen).toHaveLength(1);
  });

  it('treats a later identical trade as genuine once the window has passed', () => {
    const s = service({ activityDedupWindowMs: 1 });
    const seen = collect(s as unknown as RealtimeServiceV2);
    (s as WithPrivates).handleActivityMessage('trades', payload(), 1);
    const start = Date.now();
    while (Date.now() - start < 5) { /* let the 1ms window lapse */ }
    (s as WithPrivates).handleActivityMessage('trades', payload(), 1);
    expect(seen).toHaveLength(2);
  });

  it('can be disabled', () => {
    const s = service({ activityDedupWindowMs: 0 });
    const seen = collect(s as unknown as RealtimeServiceV2);
    (s as WithPrivates).handleActivityMessage('trades', payload(), 1);
    (s as WithPrivates).handleActivityMessage('orders_matched', payload(), 1);
    expect(seen).toHaveLength(2);
  });
});
