import { useState, useMemo } from 'react';
import type { LogEntry, LogLevel } from '../types';

interface ActivityLogProps {
  logs: LogEntry[];
}

/** Tag colour per level — the feed reads by hue, not by icon. */
const LEVEL_COLOR: Record<LogLevel, string> = {
  INFO: '#9494ad',
  WARN: '#ffc46b',
  ERROR: '#ff6b7a',
  TRADE: '#34e0b0',
  SIGNAL: '#9b8cff',
  ARB: '#4aa8ff',
  WALLET: '#d38bff',
  CHAIN: '#ff8a5b',
  SWAP: '#45c8d8',
  BRIDGE: '#b8aaff',
  KLINE: '#34e0b0',
  TREND: '#7defc9',
};

/** Levels that get a tinted row, as in the canvas live feed. */
const LEVEL_SURFACE: Partial<Record<LogLevel, { bg: string; border: string }>> = {
  SIGNAL: { bg: 'rgba(155,140,255,0.07)', border: 'rgba(155,140,255,0.20)' },
  TRADE: { bg: 'rgba(52,224,176,0.055)', border: 'rgba(52,224,176,0.18)' },
  ERROR: { bg: 'rgba(255,107,122,0.06)', border: 'rgba(255,107,122,0.20)' },
  WARN: { bg: 'rgba(255,196,107,0.05)', border: 'rgba(255,196,107,0.18)' },
};

const DEFAULT_SURFACE = { bg: '#0b0b12', border: '#1a1a25' };

const FILTER_OPTIONS: (LogLevel | 'ALL')[] = [
  'ALL',
  'TRADE',
  'SIGNAL',
  'ARB',
  'WALLET',
  'ERROR',
  'WARN',
  'INFO',
];

export function ActivityLog({ logs }: ActivityLogProps) {
  const [filter, setFilter] = useState<LogLevel | 'ALL'>('ALL');
  const [expanded, setExpanded] = useState<string | null>(null);

  const filteredLogs = useMemo(() => {
    if (filter === 'ALL') return logs;
    return logs.filter((log) => log.level === filter);
  }, [logs, filter]);

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  };

  return (
    <div className="panel dc-rise flex h-[450px] flex-col" style={{ animationDelay: '0.36s' }}>
      <div className="panel-header flex-shrink-0 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="h-[7px] w-[7px] rounded-full bg-green-400 animate-dot" />
          <h2 className="text-[15px] font-bold tracking-[-0.01em] text-white">Live Feed</h2>
          <span className="font-mono text-[10.5px] text-gray-500">
            {filteredLogs.length} EVENTS
          </span>
        </div>

        <div className="flex flex-wrap gap-1 rounded-control border border-poly-border bg-poly-deep p-1">
          {FILTER_OPTIONS.map((opt) => {
            const active = filter === opt;
            return (
              <button
                key={opt}
                onClick={() => setFilter(opt)}
                className="rounded-[9px] border px-3 py-1.5 font-mono text-[11px] font-medium tracking-[0.04em] transition-all"
                style={{
                  background: active ? 'rgba(155,140,255,0.14)' : 'transparent',
                  borderColor: active ? 'rgba(155,140,255,0.34)' : 'transparent',
                  color: active ? '#e6e0ff' : '#9494ad',
                }}
              >
                {opt}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto p-4">
        {filteredLogs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-gray-500">
            <div className="mb-2 font-mono text-[11px] tracking-[0.14em]">NO EVENTS</div>
            <div className="text-xs text-gray-600">Activity will appear here</div>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const surface = LEVEL_SURFACE[log.level] ?? DEFAULT_SURFACE;
            const isOpen = expanded === log.id;
            return (
              <div
                key={log.id}
                className="dc-pop cursor-pointer rounded-xl border px-3 py-2.5 transition-colors"
                style={{ background: surface.bg, borderColor: surface.border }}
                onClick={() => setExpanded(isOpen ? null : log.id)}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex-none pt-px font-mono text-[10.5px] text-gray-500">
                    {formatTime(log.timestamp)}
                  </span>
                  <span
                    className="w-[52px] flex-none pt-px font-mono text-[9.5px] font-bold tracking-[0.06em]"
                    style={{ color: LEVEL_COLOR[log.level] }}
                  >
                    {log.level}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-xs leading-[1.45] text-gray-400">
                    {log.message}
                  </span>
                </div>

                {isOpen && log.data !== undefined && (
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-white/5 bg-poly-deep p-3 font-mono text-[11px] text-gray-500">
                    {JSON.stringify(log.data, null, 2)}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t border-[#171722] px-5 py-2.5 font-mono text-[10.5px] text-gray-500">
        <span>LATEST FIRST</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-dot" />
          LIVE
        </span>
      </div>
    </div>
  );
}
