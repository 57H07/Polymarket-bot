/**
 * Dashboard Server - HTTP + WebSocket server for real-time monitoring
 *
 * Security model:
 * - Binds to 127.0.0.1 by default (override with DASHBOARD_HOST, e.g. 0.0.0.0
 *   only if you also put an authenticated reverse proxy in front of it).
 * - CORS is limited to loopback origins; the wildcard was removed.
 * - WebSocket upgrades from a browser are only accepted when the Origin header
 *   is a loopback origin. This blocks any web page you happen to have open
 *   from sending commands (switch to LIVE, sell positions...) to the bot.
 * - Optionally require a shared secret: set DASHBOARD_TOKEN and open the
 *   dashboard with `?token=<value>` (the client stores it in sessionStorage).
 *
 * Usage:
 *   import { startDashboard } from './src/dashboard/server.js';
 *   startDashboard(3001);
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { dashboardEmitter } from './state-emitter.js';
import type { WebSocketMessage } from './types.js';
import { loadHistory, getSession, getHistorySummary } from './session-history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True when `origin` (an Origin header value) points at this machine. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(url.host.split(':')[0]);
  } catch {
    return false;
  }
}

/**
 * Decide whether a WebSocket upgrade may proceed.
 * - Non-browser clients (no Origin header) are accepted; they are already on
 *   the loopback interface when DASHBOARD_HOST is left at its default.
 * - Browser clients must come from a loopback origin.
 * - When DASHBOARD_TOKEN is set, every client must present it.
 */
export function isUpgradeAllowed(
  origin: string | undefined,
  url: string | undefined,
  requiredToken: string | undefined,
): boolean {
  if (origin !== undefined && !isLoopbackOrigin(origin)) return false;
  if (requiredToken) {
    const params = new URL(url || '/', 'http://localhost').searchParams;
    if (params.get('token') !== requiredToken) return false;
  }
  return true;
}

function broadcast(message: WebSocketMessage): void {
  if (!wss) return;
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

export function startDashboard(
  port = 3001,
  host = process.env.DASHBOARD_HOST || '127.0.0.1',
): http.Server {
  const requiredToken = process.env.DASHBOARD_TOKEN || undefined;

  server = http.createServer((req, res) => {
    // CORS: only loopback origins, never a wildcard
    const origin = req.headers.origin;
    if (isLoopbackOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin as string);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);

    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getFullData()));
      return;
    }

    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getState()));
      return;
    }

    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getConfig()));
      return;
    }

    if (url.pathname === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(dashboardEmitter.getLogs()));
      return;
    }

    // History API endpoints
    if (url.pathname === '/api/history') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(loadHistory()));
      return;
    }

    if (url.pathname === '/api/history/summary') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getHistorySummary()));
      return;
    }

    if (url.pathname.startsWith('/api/history/')) {
      const sessionId = url.pathname.replace('/api/history/', '');
      const session = getSession(sessionId);
      if (session) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // Serve static files from dashboard/dist (path-traversal safe)
    const distPath = path.resolve(__dirname, '../../dashboard/dist');
    const requested = path.normalize(url.pathname === '/' ? 'index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(distPath, requested);

    if (filePath.startsWith(distPath) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // SPA fallback - serve index.html for all other routes
    const indexPath = path.join(distPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) => {
      const allowed = isUpgradeAllowed(info.origin || undefined, info.req.url, requiredToken);
      if (!allowed) {
        console.warn(`[Dashboard] Rejected WebSocket from origin=${info.origin || 'n/a'} ip=${info.req.socket.remoteAddress}`);
      }
      return allowed;
    },
  });

  wss.on('connection', (ws) => {
    console.log('[Dashboard] Client connected');

    // Send full state on connect
    ws.send(JSON.stringify({
      type: 'full',
      payload: dashboardEmitter.getFullData(),
    } as WebSocketMessage));

    // Handle incoming messages (commands)
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message && message.type === 'command' && typeof message.command === 'string') {
          console.log(`[Dashboard] Command received: ${message.command}`, message.payload);
          dashboardEmitter.emit('command', { command: message.command, payload: message.payload ?? {} });
        }
      } catch (e) {
        console.error('[Dashboard] Failed to parse message:', e);
      }
    });

    ws.on('close', () => {
      console.log('[Dashboard] Client disconnected');
    });

    ws.on('error', (err) => {
      console.error('[Dashboard] WebSocket error:', err.message);
    });
  });

  // Subscribe to state changes
  dashboardEmitter.on('state', (state) => {
    broadcast({ type: 'state', payload: state });
  });

  dashboardEmitter.on('log', (entry) => {
    broadcast({ type: 'log', payload: entry });
  });

  dashboardEmitter.on('config', (config) => {
    broadcast({ type: 'config', payload: config });
  });

  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`[Dashboard] Server running at http://${displayHost}:${port} (bound to ${host})`);
    console.log(`[Dashboard] WebSocket at ws://${displayHost}:${port}`);
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
      console.warn('[Dashboard] WARNING: dashboard is reachable from other machines. Set DASHBOARD_TOKEN or put it behind an authenticated proxy.');
    }
  });

  return server;
}

export function stopDashboard(): Promise<void> {
  return new Promise((resolve) => {
    if (wss) {
      wss.close();
      wss = null;
    }
    if (server) {
      server.close(() => {
        server = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export { dashboardEmitter };
