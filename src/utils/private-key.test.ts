import { describe, it, expect } from 'vitest';
import {
  normalizePrivateKey,
  isValidPrivateKey,
  describePrivateKeyProblem,
  assertPrivateKey,
} from './private-key.js';

const VALID = '0x' + 'a'.repeat(64);

describe('normalizePrivateKey', () => {
  it('treats unset and empty values as "no key"', () => {
    expect(normalizePrivateKey(undefined)).toBeNull();
    expect(normalizePrivateKey(null)).toBeNull();
    expect(normalizePrivateKey('')).toBeNull();
    expect(normalizePrivateKey('   ')).toBeNull();
  });

  it('treats the shipped placeholders as "no key"', () => {
    expect(normalizePrivateKey('0xYOUR_PRIVATE_KEY_HERE')).toBeNull();
    expect(normalizePrivateKey('your_private_key_here')).toBeNull();
    expect(normalizePrivateKey('0xYourPrivateKeyHere')).toBeNull();
  });

  it('adds the 0x prefix and strips quotes and whitespace', () => {
    expect(normalizePrivateKey('a'.repeat(64))).toBe(VALID);
    expect(normalizePrivateKey(`  "${VALID}"  `)).toBe(VALID);
  });
});

describe('isValidPrivateKey', () => {
  it('accepts a 32-byte hex key with or without the prefix', () => {
    expect(isValidPrivateKey(VALID)).toBe(true);
    expect(isValidPrivateKey('a'.repeat(64))).toBe(true);
    expect(isValidPrivateKey('0x' + 'A'.repeat(64))).toBe(true);
  });

  it('rejects placeholders, addresses, UUIDs and truncated keys', () => {
    expect(isValidPrivateKey('0xYOUR_PRIVATE_KEY_HERE')).toBe(false);
    expect(isValidPrivateKey('0x' + 'a'.repeat(40))).toBe(false);
    expect(isValidPrivateKey('3f2b8c1a-9d4e-4c7b-8a1f-2e6d5c4b3a29')).toBe(false);
    expect(isValidPrivateKey('0x' + 'a'.repeat(63))).toBe(false);
  });
});

describe('describePrivateKeyProblem', () => {
  it('returns null for a usable key', () => {
    expect(describePrivateKeyProblem(VALID)).toBeNull();
  });

  it('distinguishes unset from malformed', () => {
    expect(describePrivateKeyProblem(undefined)).toContain('is not set');
    expect(describePrivateKeyProblem('0xYOUR_PRIVATE_KEY_HERE')).toContain('is not set');
  });

  it('identifies a wallet address pasted into the key slot', () => {
    const message = describePrivateKeyProblem('0x' + 'a'.repeat(40));
    expect(message).toContain('wallet address');
    expect(message).toContain('66 characters');
  });

  it('identifies a CLOB API key (UUID) pasted into the key slot', () => {
    const message = describePrivateKeyProblem('3f2b8c1a-9d4e-4c7b-8a1f-2e6d5c4b3a29');
    expect(message).toContain('UUID');
    expect(message).toContain('derives its own API key');
  });

  it('reports the wrong length for a truncated hex key', () => {
    expect(describePrivateKeyProblem('0x' + 'a'.repeat(60))).toContain('62 characters');
  });

  it('reports non-hex content', () => {
    expect(describePrivateKeyProblem('0x' + 'z'.repeat(64))).toContain('non-hex');
  });

  it('never echoes the key value', () => {
    const secret = '0x' + 'deadbeef'.repeat(7);
    expect(describePrivateKeyProblem(secret)).not.toContain('deadbeef');
  });

  it('uses the caller-supplied variable name', () => {
    expect(describePrivateKeyProblem(undefined, 'MY_KEY')).toContain('MY_KEY');
  });
});

describe('assertPrivateKey', () => {
  it('returns the normalized key when valid', () => {
    expect(assertPrivateKey('a'.repeat(64))).toBe(VALID);
  });

  it('throws with an actionable message when invalid', () => {
    expect(() => assertPrivateKey('0x' + 'a'.repeat(40))).toThrow(/wallet address/);
    expect(() => assertPrivateKey(undefined)).toThrow(/is not set/);
  });
});
