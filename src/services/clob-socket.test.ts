import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, type WebSocket as WS } from 'ws';
import { ClobSocket, type ClobMarketEvent } from './clob-socket.js';

/**
 * These run against a local mock of the CLOB market channel. They pin the wire
 * contract that Bug 1 turned out to hinge on: the `assets_ids` subscription
 * frame, PING keepalive, `event_type` normalization, batched frames, and the
 * server error frames that the old transport swallowed into a console.log.
 */

interface Harness {
  url: string;
  /** Subscription frames the server received, parsed. */
  received: Array<Record<string, unknown>>;
  /** Raw text frames the server received (includes PING). */
  raw: string[];
  send: (payload: unknown) => void;
  close: () => Promise<void>;
  sockets: WS[];
}

const harnesses: Harness[] = [];

async function startMockServer(): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const { port } = wss.address() as { port: number };

  const harness: Harness = {
    url: `ws://127.0.0.1:${port}`,
    received: [],
    raw: [],
    sockets: [],
    send: (payload) => {
      const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
      for (const s of harness.sockets) s.send(text);
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of harness.sockets) s.terminate();
        wss.close(() => resolve());
      }),
  };

  wss.on('connection', (socket) => {
    harness.sockets.push(socket);
    socket.on('message', (data) => {
      const text = data.toString();
      harness.raw.push(text);
      if (text === 'PING') {
        socket.send('PONG');
        return;
      }
      try {
        harness.received.push(JSON.parse(text));
      } catch {
        /* non-JSON frame, already captured in raw */
      }
    });
  });

  harnesses.push(harness);
  return harness;
}

/** Wait until `predicate` holds, or fail after `timeout` ms. */
async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met within timeout');
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

describe('ClobSocket', () => {
  it('subscribes with assets_ids immediately on open', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });

    socket.addAssets(['token-a', 'token-b']);
    await until(() => server.received.length > 0);

    expect(server.received[0]).toEqual({
      assets_ids: ['token-a', 'token-b'],
      type: 'market',
      custom_feature_enabled: true,
    });

    socket.disconnect();
  });

  it('normalizes a book event into agg_orderbook', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });
    const events: ClobMarketEvent[] = [];
    socket.on('event', (e: ClobMarketEvent) => events.push(e));

    socket.addAssets(['token-a']);
    await until(() => socket.isConnected());

    server.send({
      event_type: 'book',
      asset_id: 'token-a',
      bids: [{ price: '0.48', size: '30' }],
      asks: [{ price: '0.52', size: '25' }],
      timestamp: '1750428146322',
    });

    await until(() => events.length > 0);
    expect(events[0].type).toBe('agg_orderbook');
    expect(events[0].payload.asset_id).toBe('token-a');

    socket.disconnect();
  });

  it('handles a frame carrying an array of events', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });
    const events: ClobMarketEvent[] = [];
    socket.on('event', (e: ClobMarketEvent) => events.push(e));

    socket.addAssets(['token-a']);
    await until(() => socket.isConnected());

    server.send([
      { event_type: 'last_trade_price', asset_id: 'token-a', price: '0.45', size: '10' },
      { event_type: 'tick_size_change', asset_id: 'token-a', old_tick_size: '0.01', new_tick_size: '0.001' },
    ]);

    await until(() => events.length >= 2);
    expect(events.map((e) => e.type)).toEqual(['last_trade_price', 'tick_size_change']);

    socket.disconnect();
  });

  it('surfaces server error frames as errors instead of swallowing them', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });
    const errors: Error[] = [];
    socket.on('error', (e: Error) => errors.push(e));

    socket.addAssets(['token-a']);
    await until(() => socket.isConnected());

    // The exact shape ws-live-data returned for a dead clob_market subscription.
    server.send({ body: { message: 'CLOB messages are not supported anymore' }, statusCode: 400 });

    await until(() => errors.length > 0);
    expect(errors[0].message).toContain('not supported anymore');

    socket.disconnect();
  });

  it('ignores PONG and other non-event frames', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });
    const events: ClobMarketEvent[] = [];
    socket.on('event', (e: ClobMarketEvent) => events.push(e));

    socket.addAssets(['token-a']);
    await until(() => socket.isConnected());

    server.send('PONG');
    server.send('not json at all');
    server.send({ event_type: 'something_unknown', asset_id: 'token-a' });
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toHaveLength(0);

    socket.disconnect();
  });

  it('sends PING on the keepalive interval', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url, pingIntervalMs: 30 });

    socket.addAssets(['token-a']);
    await until(() => server.raw.filter((f) => f === 'PING').length >= 2);

    socket.disconnect();
  });

  it('re-sends the full asset set when a subscription is added', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });

    socket.addAssets(['token-a']);
    await until(() => server.received.length === 1);

    socket.addAssets(['token-b']);
    await until(() => server.received.length === 2);
    expect(server.received[1].assets_ids).toEqual(['token-a', 'token-b']);

    socket.disconnect();
  });

  it('reference-counts assets so overlapping subscriptions do not cancel each other', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });

    socket.addAssets(['token-a']);
    socket.addAssets(['token-a', 'token-b']);
    await until(() => socket.isConnected());

    // Dropping the second subscription must keep token-a alive.
    socket.removeAssets(['token-a', 'token-b']);
    expect(socket.getAssetIds()).toEqual(['token-a']);

    socket.removeAssets(['token-a']);
    expect(socket.getAssetIds()).toEqual([]);
    expect(socket.isConnected()).toBe(false);
  });

  it('reconnects and re-subscribes after the server drops the connection', async () => {
    const server = await startMockServer();
    const socket = new ClobSocket({ url: server.url });

    socket.addAssets(['token-a']);
    await until(() => server.received.length === 1);

    // Simulate the server dropping us.
    for (const s of server.sockets) s.terminate();
    server.sockets.length = 0;

    await until(() => server.received.length >= 2, 5000);
    expect(server.received[1].assets_ids).toEqual(['token-a']);

    socket.disconnect();
  });
});
