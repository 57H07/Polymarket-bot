import { describe, it, expect } from 'vitest';
import { isLoopbackOrigin, isUpgradeAllowed } from './server.js';

describe('isLoopbackOrigin', () => {
  it('accepts loopback origins', () => {
    expect(isLoopbackOrigin('http://localhost:3001')).toBe(true);
    expect(isLoopbackOrigin('http://localhost:5173')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:3001')).toBe(true);
    expect(isLoopbackOrigin('http://[::1]:3001')).toBe(true);
  });

  it('rejects remote and malformed origins', () => {
    expect(isLoopbackOrigin('http://192.168.1.20:3001')).toBe(false);
    expect(isLoopbackOrigin('https://evil.example')).toBe(false);
    expect(isLoopbackOrigin('http://localhost.evil.example')).toBe(false);
    expect(isLoopbackOrigin('null')).toBe(false);
    expect(isLoopbackOrigin(undefined)).toBe(false);
  });
});

describe('isUpgradeAllowed', () => {
  it('allows loopback browsers and non-browser clients without a token', () => {
    expect(isUpgradeAllowed('http://localhost:3001', '/', undefined)).toBe(true);
    expect(isUpgradeAllowed(undefined, '/', undefined)).toBe(true);
  });

  it('blocks foreign origins even when they present the token', () => {
    expect(isUpgradeAllowed('https://evil.example', '/?token=s3cret', 's3cret')).toBe(false);
    expect(isUpgradeAllowed('https://evil.example', '/', undefined)).toBe(false);
  });

  it('enforces the token when configured', () => {
    expect(isUpgradeAllowed('http://localhost:3001', '/', 's3cret')).toBe(false);
    expect(isUpgradeAllowed('http://localhost:3001', '/?token=wrong', 's3cret')).toBe(false);
    expect(isUpgradeAllowed('http://localhost:3001', '/?token=s3cret', 's3cret')).toBe(true);
    expect(isUpgradeAllowed(undefined, '/?token=s3cret', 's3cret')).toBe(true);
  });
});
