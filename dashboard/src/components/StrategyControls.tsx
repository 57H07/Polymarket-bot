import type { BotConfig } from '../types';

interface StrategyControlsProps {
    config: BotConfig | null;
    onToggle: (strategy: string, enabled: boolean) => void;
}

interface StrategyToggleProps {
    label: string;
    meta: string;
    enabled: boolean;
    /** Hex accent for this strategy — inline, so Tailwind never has to guess. */
    color: string;
    onChange: (enabled: boolean) => void;
}

function StrategyToggle({ label, meta, enabled, color, onChange }: StrategyToggleProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => onChange(!enabled)}
            className="flex w-full items-center gap-3 rounded-[14px] border px-3.5 py-3 text-left transition-all duration-200 hover:translate-x-0.5"
            style={{
                background: enabled
                    ? `linear-gradient(120deg, ${color}16, rgba(255,255,255,0.012))`
                    : '#0b0b12',
                borderColor: enabled ? `${color}3d` : '#1a1a25',
            }}
        >
            <span
                className="h-2 w-2 flex-none rounded-full"
                style={{ background: enabled ? color : '#2c2c3c' }}
            />
            <span className="min-w-0 flex-1">
                <span
                    className="block truncate text-[13.5px] font-semibold"
                    style={{ color: enabled ? '#eaeaf5' : '#9494ad' }}
                >
                    {label}
                </span>
                <span className="mt-0.5 block font-mono text-[10.5px] text-gray-500">{meta}</span>
            </span>
            <span
                className="relative h-[21px] w-[38px] flex-none rounded-full border transition-colors duration-200"
                style={{
                    background: enabled ? `${color}44` : '#1a1a25',
                    borderColor: enabled ? `${color}66` : '#24242f',
                }}
            >
                <span
                    className="absolute top-0.5 h-[15px] w-[15px] rounded-full transition-all duration-200"
                    style={{
                        left: enabled ? '20px' : '3px',
                        background: enabled ? color : '#3a3a4c',
                    }}
                />
            </span>
        </button>
    );
}

export function StrategyControls({ config, onToggle }: StrategyControlsProps) {
    if (!config) return null;

    const strategies = [
        {
            key: 'smartMoney',
            label: 'Smart Money',
            meta: 'copy trading · whale wallets',
            color: '#9b8cff',
            enabled: config.smartMoney?.enabled ?? false,
        },
        {
            key: 'arbitrage',
            label: 'Arbitrage',
            meta: `threshold ${((config.arbitrage?.profitThreshold ?? 0) * 100).toFixed(1)}%`,
            color: '#4aa8ff',
            enabled: config.arbitrage?.enabled ?? false,
        },
        {
            key: 'dipArb',
            label: 'DipArb',
            meta: `crypto short-term · ${config.dipArb?.coins?.length ?? 0} coins`,
            color: '#34e0b0',
            enabled: config.dipArb?.enabled ?? false,
        },
        {
            key: 'directTrading',
            label: 'Direct Trading',
            meta: 'trend following',
            color: '#ffc46b',
            enabled: config.directTrading?.enabled ?? false,
        },
    ];

    const activeCount = strategies.filter((s) => s.enabled).length;

    return (
        <div className="panel dc-rise" style={{ animationDelay: '0.22s' }}>
            <div className="panel-header">
                <h3 className="text-[15px] font-bold tracking-[-0.01em] text-white">Strategies</h3>
                <span className="font-mono text-[11px] text-gray-500">
                    {activeCount}/4 ACTIVE
                </span>
            </div>
            <div className="panel-body space-y-2">
                {strategies.map((s) => (
                    <StrategyToggle
                        key={s.key}
                        label={s.label}
                        meta={s.meta}
                        color={s.color}
                        enabled={s.enabled}
                        onChange={(enabled) => onToggle(s.key, enabled)}
                    />
                ))}
                <div className="pt-1 text-center text-[11px] leading-relaxed text-gray-600">
                    Changes take effect immediately. Trading strategies need sufficient USDC.e.
                </div>
            </div>
        </div>
    );
}
