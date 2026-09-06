interface ConnectionStatusProps {
  connected: boolean;
  error: string | null;
}

export function ConnectionStatus({ connected, error }: ConnectionStatusProps) {
  if (connected && !error) return null;

  const tone = error
    ? { bg: 'rgba(255,107,122,0.07)', border: 'rgba(255,107,122,0.24)', fg: '#ff6b7a' }
    : { bg: 'rgba(255,196,107,0.07)', border: 'rgba(255,196,107,0.24)', fg: '#ffc46b' };

  return (
    <div className="px-[clamp(14px,2.4vw,40px)] pt-2">
      <div
        className="dc-rise flex items-center justify-center gap-3 rounded-control border px-4 py-2 text-xs"
        style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
      >
        {error ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full animate-dot" style={{ background: tone.fg }} />
            <span>
              <span className="font-semibold">Connection error:</span> {error}
            </span>
          </>
        ) : (
          <>
            <span className="spinner-ring" style={{ borderTopColor: tone.fg }} />
            <span>Connecting to the bot…</span>
          </>
        )}
      </div>
    </div>
  );
}
