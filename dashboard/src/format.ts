/**
 * One number format for the whole dashboard.
 *
 * `toLocaleString()` without an explicit locale follows the browser's, so a
 * French browser rendered "-$1,66" next to a hardcoded "$0.00" from `toFixed`
 * — and, worse, showed 12.785 shares as "12,785". Everything money- or
 * size-shaped goes through here so the page reads the same everywhere.
 */

const LOCALE = 'en-US';

/** Fixed-decimal number, no currency symbol. */
export function num(value: number, decimals = 2): string {
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Number with grouping and at most `decimals` places, trailing zeros dropped. */
export function amount(value: number, decimals = 2): string {
  return value.toLocaleString(LOCALE, { maximumFractionDigits: decimals });
}

/** `$1,234.50` — always a dollar amount, never a share count. */
export function usd(value: number, decimals = 2): string {
  return `$${num(Math.abs(value), decimals)}`;
}

/** `+$1.20` / `-$1.20`, sign outside the symbol. */
export function signedUsd(value: number, decimals = 2): string {
  return `${value >= 0 ? '+' : '-'}${usd(value, decimals)}`;
}

/** Takes a fraction (0.12), renders a percentage ("+12.0%"). */
export function signedPct(fraction: number, decimals = 1): string {
  const pct = fraction * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(decimals)}%`;
}
