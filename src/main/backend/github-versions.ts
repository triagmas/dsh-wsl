/**
 * Upstream DSH release lookup.
 *
 * Strictly read-only and untrusted-input-safe:
 *  - one hard-coded endpoint, no redirects beyond GitHub's own host;
 *  - short timeout, capped response size, no credentials or tokens;
 *  - the last good result survives offline starts, errors are reported as text;
 *  - nothing here can install, download or upgrade a package.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../core/logger.js';
import { sanitizeForDisplay } from '../core/display.js';
import {
  RELEASES_ENDPOINT,
  VERSION_CACHE_TTL_MS,
  VERSION_FETCH_TIMEOUT_MS,
  VERSION_MAX_BYTES,
  applyLookupError,
  emptyCache,
  selectLatestRelease,
  shouldRefresh,
  type VersionCacheState,
} from '../core/versions.js';

export interface LatestVersionServiceOptions {
  cachePath: string;
  log: Logger;
  now?: () => number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
}

export interface LatestVersionService {
  /** Current state, never blocking on a network call. */
  snapshot(): VersionCacheState;
  /** Fetch when the cache is stale; resolves with the resulting state. */
  refreshIfStale(): Promise<VersionCacheState>;
  /** Unconditional refresh, used by an explicit user request. */
  refresh(): Promise<VersionCacheState>;
}

const ALLOWED_ORIGIN = 'https://api.github.com';

function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) return Promise.resolve('');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let text = '';
  const pump = (): Promise<string> =>
    reader.read().then(({ done, value }) => {
      if (done) return text;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error(`response larger than ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
      return pump();
    });
  return pump();
}

export function createLatestVersionService(options: LatestVersionServiceOptions): LatestVersionService {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? VERSION_FETCH_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? VERSION_CACHE_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  let state: VersionCacheState = loadCache(options.cachePath, options.log);
  let inFlight: Promise<VersionCacheState> | null = null;

  const save = (next: VersionCacheState): void => {
    try {
      mkdirSync(dirname(options.cachePath), { recursive: true });
      writeFileSync(
        options.cachePath,
        JSON.stringify({ latest: next.latest, checkedAt: next.checkedAt }, null, 2),
        'utf8',
      );
    } catch (error) {
      options.log.debug(`version cache write failed: ${error instanceof Error ? error.name : 'error'}`);
    }
  };

  const run = async (): Promise<VersionCacheState> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(RELEASES_ENDPOINT, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'wsl-web-shell',
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        state = applyLookupError(state, `upstream lookup failed (HTTP ${response.status})`);
        options.log.warn(`latest DSH version lookup failed: HTTP ${response.status}`);
        return state;
      }
      const body = await readCapped(response, VERSION_MAX_BYTES);
      const latest = selectLatestRelease(JSON.parse(body) as unknown);
      if (latest === null) {
        state = applyLookupError(state, 'upstream returned no published dsh release');
        options.log.warn('latest DSH version lookup found no dsh-v* release');
        return state;
      }
      state = { latest, checkedAt: new Date(now()).toISOString(), error: null };
      save(state);
      options.log.info(`latest DSH release: ${latest.version}`);
      return state;
    } catch (error) {
      const message = sanitizeForDisplay(
        error instanceof Error && error.name === 'AbortError'
          ? 'upstream lookup timed out'
          : `upstream lookup failed: ${error instanceof Error ? error.message : 'unknown'}`,
        160,
      );
      state = applyLookupError(state, message);
      options.log.warn(message);
      return state;
    } finally {
      clearTimeout(timer);
    }
  };

  const refresh = (): Promise<VersionCacheState> => {
    if (inFlight !== null) return inFlight;
    const request = run();
    inFlight = request.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    snapshot: () => state,
    refreshIfStale: () => (shouldRefresh(state, now(), ttlMs) ? refresh() : Promise.resolve(state)),
    refresh,
  };
}

function loadCache(cachePath: string, log: Logger): VersionCacheState {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8')) as Partial<VersionCacheState>;
    const latest = parsed.latest;
    const checkedAt = typeof parsed.checkedAt === 'string' ? parsed.checkedAt : null;
    if (
      latest !== null &&
      latest !== undefined &&
      typeof latest === 'object' &&
      typeof latest.version === 'string' &&
      typeof latest.url === 'string' &&
      /^https:\/\/github\.com\//.test(latest.url) &&
      typeof latest.publishedAt === 'string'
    ) {
      return {
        latest: {
          version: latest.version,
          url: latest.url,
          prerelease: latest.prerelease === true,
          publishedAt: latest.publishedAt,
        },
        checkedAt,
        error: null,
      };
    }
    return emptyCache();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.debug('version cache unreadable, starting empty');
    }
    return emptyCache();
  }
}

/** Only the documented endpoint may be fetched. */
export function isAllowedEndpoint(url: string): boolean {
  return url.startsWith(`${ALLOWED_ORIGIN}/`);
}
