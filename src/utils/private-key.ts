/**
 * Private Key Validation
 *
 * Provides helpers for:
 * - Detecting unset / placeholder keys (from .env.example and the docs)
 * - Distinguishing a wallet address pasted into the private key slot
 * - Producing actionable error messages that never leak the key itself
 *
 * An Ethereum private key is 32 bytes: `0x` + 64 hex characters (66 chars).
 * A wallet address is 20 bytes: `0x` + 40 hex characters (42 chars) - the most
 * common mistake, and indistinguishable from a key without a length check.
 */

/** Read-only key used when no signing key is available (reads never touch it). */
export const READ_ONLY_PRIVATE_KEY = '0x' + '1'.repeat(64);

/** Placeholder values shipped in .env.example, the README and the examples. */
export const PLACEHOLDER_KEYS = new Set([
  '0xYOUR_PRIVATE_KEY_HERE',
  'YOUR_PRIVATE_KEY_HERE',
  'your_private_key_here',
  '0xyour_private_key_here',
  '0xYourPrivateKeyHere',
  'YourPrivateKeyHere',
  '0xYOUR_NEW_WALLET_PRIVATE_KEY',
  'YOUR_NEW_WALLET_PRIVATE_KEY',
]);

const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_BODY_RE = /^0x[0-9a-fA-F]*$/;
const UUID_RE = /^(0x)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Normalize a raw key: trims whitespace/quotes and adds the `0x` prefix.
 * Returns `null` for unset, empty or placeholder values - i.e. "no key was
 * provided", as distinct from "a key was provided but it is malformed".
 */
export function normalizePrivateKey(raw?: string | null): string | null {
  if (raw === undefined || raw === null) return null;

  const trimmed = raw.trim().replace(/^['"]|['"]$/g, '');
  if (trimmed === '') return null;
  if (PLACEHOLDER_KEYS.has(trimmed)) return null;

  const prefixed = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  return PLACEHOLDER_KEYS.has(prefixed) ? null : prefixed;
}

/** True when `raw` is a well-formed private key (0x + 64 hex characters). */
export function isValidPrivateKey(raw?: string | null): boolean {
  const key = normalizePrivateKey(raw);
  return key !== null && PRIVATE_KEY_RE.test(key);
}

/**
 * Explain why `raw` is not a usable private key, or `null` if it is fine.
 * The message never contains the key value.
 */
export function describePrivateKeyProblem(
  raw?: string | null,
  envVar = 'POLYMARKET_PRIVATE_KEY'
): string | null {
  const key = normalizePrivateKey(raw);

  if (key === null) {
    return `${envVar} is not set. Copy .env.example to .env and add your private key (0x + 64 hex characters).`;
  }

  if (PRIVATE_KEY_RE.test(key)) return null;

  if (key.length === 42 && HEX_BODY_RE.test(key)) {
    return `${envVar} is 42 characters - that is a wallet address, not a private key. Export the private key from your wallet (MetaMask: Account details -> Show private key); it is 66 characters (0x + 64 hex).`;
  }

  if (UUID_RE.test(key)) {
    return `${envVar} looks like a UUID - that is a CLOB API key, not a private key. The bot derives its own API key/secret/passphrase at runtime, so it does not need one in .env; what it needs here is your wallet's private key (0x + 64 hex characters), exported from the wallet itself.`;
  }

  if (!HEX_BODY_RE.test(key)) {
    return `${envVar} is malformed: expected 0x + 64 hex characters, but it contains non-hex characters.`;
  }

  return `${envVar} is malformed: expected 0x + 64 hex characters (66 total), got ${key.length} characters.`;
}

/**
 * Return the normalized key, or throw an Error explaining what is wrong.
 * Use at every point where a key is about to be handed to `new Wallet()`.
 */
export function assertPrivateKey(
  raw?: string | null,
  envVar = 'POLYMARKET_PRIVATE_KEY'
): string {
  const problem = describePrivateKeyProblem(raw, envVar);
  if (problem) throw new Error(problem);
  return normalizePrivateKey(raw) as string;
}
