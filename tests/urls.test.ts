import { describe, expect, it } from 'vitest';
import {
  buildOrigin,
  containsSecret,
  isAllowedNavigation,
  isSafeExternalUrl,
  parseStartupLine,
  redactSecrets,
} from '../src/main/backend/urls.js';

const TOKEN = 'test-token-0123456789abcdef';
const VALID = `dsh web: http://127.0.0.1:3080/?token=${TOKEN}`;

describe('parseStartupLine', () => {
  it('accepts the verified upstream line shape', () => {
    const result = parseStartupLine(VALID, { port: 3080 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toBe(TOKEN);
    expect(result.origin).toBe('http://127.0.0.1:3080');
    expect(result.tokenUrl).toContain('?token=');
  });

  it('tolerates a trailing carriage return', () => {
    expect(parseStartupLine(`${VALID}\r`, { port: 3080 }).ok).toBe(true);
  });

  it('ignores unrelated log lines', () => {
    expect(parseStartupLine('dsh web: opening the default browser', { port: 3080 })).toEqual({
      ok: false,
      error: 'not-a-startup-line',
    });
    expect(parseStartupLine('[stderr] something', { port: 3080 })).toEqual({
      ok: false,
      error: 'not-a-startup-line',
    });
  });

  it.each([
    ['http://localhost:3080/?token=', 'unexpected-host'],
    ['http://0.0.0.0:3080/?token=', 'unexpected-host'],
    ['http://127.0.0.1:3090/?token=', 'unexpected-port'],
    ['https://127.0.0.1:3080/?token=', 'unsupported-protocol'],
    ['file:///etc/passwd?token=', 'unsupported-protocol'],
    ['http://user:pw@127.0.0.1:3080/?token=', 'credentials-in-url'],
    ['http://127.0.0.1:3080/app/?token=', 'unexpected-path'],
    ['http://127.0.0.1:3080/?token=abc#frag', 'unexpected-fragment'],
    ['http://127.0.0.1:3080/?token=', 'missing-token'],
    ['http://127.0.0.1:3080/?tok=abcdefghijklmnopqrst', 'unexpected-query'],
    ['http://127.0.0.1:3080/?token=short', 'malformed-token'],
  ])('rejects %s', (url, error) => {
    const result = parseStartupLine(`dsh web: ${url}`, { port: 3080 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  it('rejects a token smuggled into another query parameter', () => {
    const result = parseStartupLine(`dsh web: http://127.0.0.1:3080/?redirect=http://evil.test`, { port: 3080 });
    expect(result).toEqual({ ok: false, error: 'unexpected-query' });
  });

  it('rejects an interpolated host that only looks like loopback', () => {
    for (const host of ['127.0.0.1.evil.test', '127.0.0.10', '[::1]']) {
      const result = parseStartupLine(`dsh web: http://${host}:3080/?token=${TOKEN}`, { port: 3080 });
      expect(result.ok).toBe(false);
    }
  });

  it('never echoes the token in an error', () => {
    const result = parseStartupLine(`dsh web: http://127.0.0.1:9999/?token=${TOKEN}`, { port: 3080 });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('redaction', () => {
  it('strips tokens from query strings and diagnostic text', () => {
    expect(redactSecrets(VALID)).toBe('dsh web: http://127.0.0.1:3080/?token=[redacted]');
    expect(redactSecrets('GET /?token=abc123&x=1')).toBe('GET /?token=[redacted]&x=1');
    expect(containsSecret(VALID)).toBe(true);
    expect(containsSecret(redactSecrets(VALID))).toBe(false);
  });
});

describe('navigation helpers', () => {
  const origin = buildOrigin(3080);

  it('allows only the exact origin', () => {
    expect(isAllowedNavigation(`${origin}/`, origin)).toBe(true);
    expect(isAllowedNavigation(`${origin}/session/abc`, origin)).toBe(true);
    expect(isAllowedNavigation('http://127.0.0.1:3081/', origin)).toBe(false);
    expect(isAllowedNavigation('http://localhost:3080/', origin)).toBe(false);
    expect(isAllowedNavigation('https://127.0.0.1:3080/', origin)).toBe(false);
  });

  it('only hands safe public HTTPS links to the system browser', () => {
    expect(isSafeExternalUrl('https://deepseek.com/docs')).toBe(true);
    expect(isSafeExternalUrl('http://deepseek.com/docs')).toBe(false);
    expect(isSafeExternalUrl('https://localhost/admin')).toBe(false);
    expect(isSafeExternalUrl('https://192.168.1.1/admin')).toBe(false);
    expect(isSafeExternalUrl('https://user:pw@example.com')).toBe(false);
    expect(isSafeExternalUrl('file:///C:/Windows')).toBe(false);
  });
});
