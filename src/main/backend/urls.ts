/**
 * Startup URL handling for the DeepSeek Harness web backend.
 *
 * Verified upstream contract (`@deepseek-ai/dsh-web-app` 0.2.1-rc.5, README +
 * `lib/index.js`): after the profile tree settles and Connection authentication
 * is available, the process prints one line
 *
 *     dsh web: http://127.0.0.1:<port>/?token=<process-token>
 *
 * The token is a per-process credential. `GET /?token=...` writes a signed,
 * host-only, HttpOnly session cookie and redirects to `./` without the token.
 * Everything here is pure so it can be unit-tested without Electron.
 */
import { LOOPBACK_HOST } from '../../shared/types.js';

export const STARTUP_LINE_PREFIX = 'dsh web: ';

export type StartupUrlError =
  | 'not-a-startup-line'
  | 'malformed-url'
  | 'unsupported-protocol'
  | 'unexpected-host'
  | 'unexpected-port'
  | 'credentials-in-url'
  | 'unexpected-path'
  | 'unexpected-fragment'
  | 'unexpected-query'
  | 'missing-token'
  | 'malformed-token';

export interface StartupUrlExpectation {
  port: number;
  host?: string;
}

export type StartupUrlResult =
  | { ok: true; tokenUrl: string; token: string; origin: string; url: URL }
  | { ok: false; error: StartupUrlError };

/** `http://127.0.0.1:<port>` — the only origin the shell may ever load. */
export function buildOrigin(port: number, host: string = LOOPBACK_HOST): string {
  return `http://${host}:${port}`;
}

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

/**
 * Parse and validate a single `dsh web:` startup line.
 * Rejects anything that is not the exact loopback origin plus one token query
 * parameter, so a tampered or redirected advertisement can never be loaded.
 */
export function parseStartupLine(
  line: string,
  expectation: StartupUrlExpectation,
): StartupUrlResult {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.startsWith(STARTUP_LINE_PREFIX)) return { ok: false, error: 'not-a-startup-line' };

  const rawUrl = trimmed.slice(STARTUP_LINE_PREFIX.length).trim();
  // The prefix also fronts non-URL notices ("opening the default browser").
  if (!rawUrl.includes('://')) return { ok: false, error: 'not-a-startup-line' };

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'malformed-url' };
  }

  if (url.protocol !== 'http:') return { ok: false, error: 'unsupported-protocol' };
  if (url.username !== '' || url.password !== '') return { ok: false, error: 'credentials-in-url' };

  const expectedHost = expectation.host ?? LOOPBACK_HOST;
  if (url.hostname !== expectedHost) return { ok: false, error: 'unexpected-host' };
  if (url.port !== String(expectation.port)) return { ok: false, error: 'unexpected-port' };
  if (url.hash !== '') return { ok: false, error: 'unexpected-fragment' };
  if (url.pathname !== '/' && url.pathname !== '') return { ok: false, error: 'unexpected-path' };

  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== 'token') return { ok: false, error: 'unexpected-query' };

  const token = entries[0][1];
  if (token === '') return { ok: false, error: 'missing-token' };
  if (!TOKEN_PATTERN.test(token)) return { ok: false, error: 'malformed-token' };

  return {
    ok: true,
    token,
    tokenUrl: url.toString(),
    origin: buildOrigin(expectation.port, expectedHost),
    url,
  };
}

/** True when `candidate` is exactly the allowed origin root or below it. */
export function isAllowedNavigation(candidate: string, origin: string): boolean {
  let url: URL;
  let allowed: URL;
  try {
    url = new URL(candidate);
    allowed = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === allowed.protocol && url.host === allowed.host;
}

/** External hand-off policy: only plain HTTPS pages, no credentials, no localhost. */
export function isSafeExternalUrl(candidate: string): boolean {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) {
    // Literal addresses (loopback, LAN, link-local) are never handed to the OS.
    return false;
  }
  return true;
}

/**
 * Remove token-bearing credentials from any text that may reach a log, a
 * status message, a crash report or the UI.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&]token=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/(\btoken["']?\s*[:=]\s*["']?)[A-Za-z0-9._~-]{16,}/gi, '$1[redacted]');
}

/** True when the text still contains something that looks like a live token. */
export function containsSecret(text: string): boolean {
  return /[?&]token=(?!\[redacted\])/i.test(text) || redactSecrets(text) !== text;
}
