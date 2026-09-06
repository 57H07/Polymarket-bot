/**
 * ClobSocket - WebSocket transport for Polymarket's CLOB market channel
 *
 * Polymarket removed the `clob_market` / `clob_user` topics from the RTDS
 * socket (`wss://ws-live-data.polymarket.com`); it now answers those
 * subscriptions with:
 *
 *   {"body":{"message":"CLOB messages are not supported anymore..."},"statusCode":400}
 *
 * Live orderbook and price data lives on a separate socket with a different
 * protocol, implemented here. RealtimeServiceV2 keeps the RTDS client for the
 * topics that still work there (activity, crypto_prices, comments, rfq, ...)
 * and routes market data through this class.
 *
 * Protocol notes:
 * - Subscribe with `{assets_ids, type: 'market'}` - note `assets_ids`, not
 *   `asset_ids` - and send it immediately on open, or the server closes.
 * - There is no incremental unsubscribe: the full asset set is re-sent
 *   whenever it changes, and the socket is reopened to drop assets.
 * - Keepalive is the literal string `PING` every ~10s; the server replies
 *   `PONG` and drops idle sockets.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

export const CLOB_WS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
export const CLOB_WS_USER_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

/** A single event from the market channel, normalized to RTDS topic/type shape. */
export interface ClobMarketEvent {
  /** RTDS-compatible message type: agg_orderbook | price_change | last_trade_price | tick_size_change */
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
}

/** Maps CLOB `event_type` values onto the message types handleMarketMessage already understands. */
const EVENT_TYPE_MAP: Record<string, string> = {
  book: 'agg_orderbook',
  agg_orderbook: 'agg_orderbook',
  price_change: 'price_change',
  last_trade_price: 'last_trade_price',
  tick_size_change: 'tick_size_change',
  best_bid_ask: 'best_bid_ask',
};

/**
 * Event types the channel emits that this transport deliberately ignores.
 * Listed explicitly so they don't show up as "Unknown event_type" noise.
 */
const IGNORED_EVENT_TYPES = new Set(['new_market']);

export interface ClobSocketConfig {
  url?: string;
  /** Keepalive interval in ms. The server drops sockets idle for ~10s. */
  pingIntervalMs?: number;
  autoReconnect?: boolean;
  debug?: boolean;
}

export class ClobSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly pingIntervalMs: number;
  private readonly autoReconnect: boolean;
  private readonly debug: boolean;

  /** Union of every token id any subscriber currently wants. */
  private assetIds: Set<string> = new Set();
  /** Reference count per token id, so overlapping subscriptions don't cancel each other. */
  private refCounts: Map<string, number> = new Map();

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;
  private static readonly MAX_RECONNECT_DELAY_MS = 60_000;
  private manualDisconnect = false;
  private open = false;

  constructor(config: ClobSocketConfig = {}) {
    super();
    this.url = config.url ?? CLOB_WS_MARKET_URL;
    this.pingIntervalMs = config.pingIntervalMs ?? 10_000;
    this.autoReconnect = config.autoReconnect ?? true;
    this.debug = config.debug ?? false;
  }

  isConnected(): boolean {
    return this.open;
  }

  /** Token ids currently subscribed. */
  getAssetIds(): string[] {
    return [...this.assetIds];
  }

  /**
   * Add token ids to the subscription set. Opens the socket on first use and
   * re-sends the full set when it grows.
   */
  addAssets(tokenIds: string[]): void {
    let changed = false;
    for (const id of tokenIds) {
      const next = (this.refCounts.get(id) ?? 0) + 1;
      this.refCounts.set(id, next);
      if (next === 1) {
        this.assetIds.add(id);
        changed = true;
      }
    }
    if (!changed) return;

    this.manualDisconnect = false;
    if (!this.ws) {
      this.connect();
    } else if (this.open) {
      this.sendSubscription();
    }
  }

  /**
   * Drop token ids. The channel has no incremental unsubscribe, so removing
   * assets means reopening the socket with the reduced set (or closing it when
   * nothing is left).
   */
  removeAssets(tokenIds: string[]): void {
    let changed = false;
    for (const id of tokenIds) {
      const current = this.refCounts.get(id);
      if (current === undefined) continue;
      if (current <= 1) {
        this.refCounts.delete(id);
        this.assetIds.delete(id);
        changed = true;
      } else {
        this.refCounts.set(id, current - 1);
      }
    }
    if (!changed) return;

    if (this.assetIds.size === 0) {
      this.disconnect();
    } else {
      this.reopen();
    }
  }

  /** Close the socket and clear all subscriptions. */
  disconnect(): void {
    this.manualDisconnect = true;
    this.clearTimers();
    this.assetIds.clear();
    this.refCounts.clear();
    this.closeSocket();
    this.open = false;
  }

  // ===== Internals =====

  private connect(): void {
    if (this.assetIds.size === 0 || this.manualDisconnect) return;

    this.log(`Connecting to ${this.url} (${this.assetIds.size} assets)`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.emitError(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.reconnectDelayMs = 1000;
      // The server closes the connection if no subscription arrives right away.
      this.sendSubscription();
      this.startPing();
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.handleRaw(data.toString());
    });

    ws.on('error', (err: Error) => {
      if (this.ws !== ws) return;
      this.emitError(err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      this.open = false;
      this.stopPing();
      this.ws = null;
      this.log(`Closed (code ${code})`);
      this.emit('disconnected', code, reason?.toString?.() ?? '');
      this.scheduleReconnect();
    });
  }

  /** Close and immediately reconnect with the current asset set. */
  private reopen(): void {
    this.stopPing();
    this.closeSocket();
    this.open = false;
    this.connect();
  }

  private closeSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    // Detach first so the close handler doesn't schedule a reconnect for a
    // socket we are deliberately replacing. Keep a no-op error listener: ws
    // emits asynchronously while tearing down, and an unhandled 'error' event
    // on an EventEmitter is an uncaught exception that would kill the process.
    ws.removeAllListeners();
    ws.on('error', () => {});
    try {
      // close() on a socket that has not finished its handshake throws
      // "WebSocket was closed before the connection was established"; terminate
      // tears it down without the handshake.
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    } catch {
      /* already closing */
    }
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      assets_ids: [...this.assetIds],
      type: 'market',
      custom_feature_enabled: true,
    };
    this.log(`Subscribing to ${msg.assets_ids.length} assets`);
    this.ws.send(JSON.stringify(msg), (err?: Error) => {
      if (err) this.emitError(err);
    });
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('PING');
      }
    }, this.pingIntervalMs);
    // Never hold the process open just for the keepalive.
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.autoReconnect || this.manualDisconnect) return;
    if (this.assetIds.size === 0 || this.reconnectTimer) return;

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, ClobSocket.MAX_RECONNECT_DELAY_MS);
    this.log(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private handleRaw(raw: string): void {
    const text = raw.trim();
    if (text === '' || text === 'PONG' || text === 'PING') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON frames are keepalive or server notices; surface only in debug.
      this.log(`Ignoring non-JSON frame: ${text.slice(0, 120)}`);
      return;
    }

    // Implementations differ: a frame is either one event or an array of them.
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const record = event as Record<string, unknown>;

      // Server-side error frames (the shape that used to be swallowed silently).
      if (typeof record.statusCode === 'number' && record.statusCode >= 400) {
        const body = record.body as { message?: string } | undefined;
        this.emitError(new Error(body?.message ?? `CLOB socket error ${record.statusCode}`));
        continue;
      }

      const rawType = record.event_type as string | undefined;
      if (!rawType) continue;
      if (IGNORED_EVENT_TYPES.has(rawType)) continue;

      const type = EVENT_TYPE_MAP[rawType];
      if (!type) {
        this.log(`Unknown event_type: ${rawType}`);
        continue;
      }

      const clobEvent: ClobMarketEvent = {
        type,
        payload: record,
        timestamp: Date.now(),
      };
      this.emit('event', clobEvent);
    }
  }

  private emitError(err: unknown): void {
    const error = err instanceof Error ? err : new Error(String(err));
    this.log(`Error: ${error.message}`);
    // EventEmitter throws on an unhandled 'error' event; only emit if listened for.
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }

  private log(message: string): void {
    if (this.debug) console.log(`[ClobSocket] ${message}`);
  }
}
