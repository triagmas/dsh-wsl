/**
 * Issue #9 version awareness: executable output parsing, SemVer precedence,
 * GitHub release filtering and the cached lookup service (offline safety).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RELEASES_ENDPOINT,
  VERSION_CACHE_TTL_MS,
  applyLookupError,
  compareSemver,
  emptyCache,
  isNewer,
  parseDshVersion,
  parseSemver,
  selectLatestRelease,
  shouldRefresh,
} from '../src/main/core/versions.js';
import { createLatestVersionService, isAllowedEndpoint } from '../src/main/backend/github-versions.js';
import { createNullLogger } from '../src/main/core/logger.js';

const repositories: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wsl-web-shell-versions-'));
  repositories.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of repositories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseDshVersion', () => {
  it('reads the plain CLI output', () => {
    expect(parseDshVersion('0.2.1-rc.5\n')).toBe('0.2.1-rc.5');
  });

  it('survives banners, ANSI colour and extra text', () => {
    expect(parseDshVersion('\u001B[32mdsh/0.2.2-rc.1\u001B[0m node/v22.23.2')).toBe('0.2.2-rc.1');
    expect(parseDshVersion('DeepSeek Harness 0.3.0')).toBe('0.3.0');
  });

  it('rejects output without a version', () => {
    expect(parseDshVersion('usage: dsh <command>')).toBeNull();
    expect(parseDshVersion('')).toBeNull();
  });
});

describe('SemVer precedence', () => {
  it('orders releases, prereleases and builds like the SemVer spec', () => {
    expect(compareSemver('0.2.1', '0.2.0')).toBe(1);
    expect(compareSemver('0.2.0', '0.2.1-rc.5')).toBe(-1);
    expect(compareSemver('0.2.2-rc.1', '0.2.1-rc.5')).toBe(1);
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-rc.9')).toBe(1);
    expect(compareSemver('1.0.0+build.5', '1.0.0')).toBe(0);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha')).toBe(1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareSemver('2.0.0', '10.0.0')).toBe(-1);
  });

  it('treats unparsable values as equal instead of inventing an update', () => {
    expect(compareSemver('nightly', '0.2.1')).toBe(0);
    expect(isNewer('nightly', '0.2.1')).toBe(false);
  });

  it('parses prerelease identifiers', () => {
    expect(parseSemver('1.2.3-rc.4+build')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '4'],
    });
    expect(parseSemver('nope')).toBeNull();
  });

  it('never reports an update without an installed version', () => {
    expect(isNewer('0.2.2-rc.1', null)).toBe(false);
    expect(isNewer('0.2.2-rc.1', '0.2.1-rc.5')).toBe(true);
  });
});

describe('selectLatestRelease', () => {
  const payload = [
    {
      tag_name: 'desktop-v1.0.0',
      draft: false,
      prerelease: false,
      published_at: '2026-11-05T00:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/desktop-v1.0.0',
    },
    {
      tag_name: 'dsh-v0.2.2-rc.1',
      draft: false,
      prerelease: true,
      published_at: '2026-11-04T10:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
    },
    {
      tag_name: 'dsh-v0.2.1-rc.5',
      draft: false,
      prerelease: true,
      published_at: '2026-10-20T10:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5',
    },
    {
      tag_name: 'dsh-v0.2.3-rc.0',
      draft: true,
      prerelease: true,
      published_at: '2026-11-06T10:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.3-rc.0',
    },
    {
      tag_name: 'dsh-vnext',
      draft: false,
      prerelease: false,
      published_at: '2026-11-07T10:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-vnext',
    },
  ];

  it('picks the newest published dsh-v release and keeps the prerelease flag', () => {
    expect(selectLatestRelease(payload)).toEqual({
      version: '0.2.2-rc.1',
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
      prerelease: true,
      publishedAt: '2026-11-04T10:00:00Z',
    });
  });

  it('ignores drafts, unrelated tags, non-GitHub URLs and unknown values', () => {
    expect(
      selectLatestRelease([
        { tag_name: 'dsh-v1.0.0', draft: true, published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/a/b' },
        { tag_name: 'other-v1.0.0', published_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/a/b' },
        { tag_name: 'dsh-v1.0.0', published_at: '2026-01-01T00:00:00Z', html_url: 'http://example.com/x' },
      ]),
    ).toBeNull();
    expect(selectLatestRelease({})).toBeNull();
    expect(selectLatestRelease([])).toBeNull();
  });

  it('prefers the later publication date, not the array order', () => {
    const selected = selectLatestRelease([
      {
        tag_name: 'dsh-v0.2.2-rc.1',
        published_at: '2026-11-04T10:00:00Z',
        html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
      },
      {
        tag_name: 'dsh-v0.2.1-rc.5',
        published_at: '2026-10-20T10:00:00Z',
        html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5',
      },
    ]);
    expect(selected?.version).toBe('0.2.2-rc.1');
  });
});

describe('cache policy', () => {
  it('refreshes when empty, stale or corrupted', () => {
    const now = Date.parse('2026-11-07T00:00:00Z');
    expect(shouldRefresh(emptyCache(), now)).toBe(true);
    expect(shouldRefresh({ latest: null, checkedAt: '2026-11-06T23:00:00Z', error: null }, now)).toBe(false);
    expect(shouldRefresh({ latest: null, checkedAt: 'not-a-date', error: null }, now)).toBe(true);
    const stale = new Date(now - VERSION_CACHE_TTL_MS - 1).toISOString();
    expect(shouldRefresh({ latest: null, checkedAt: stale, error: null }, now)).toBe(true);
  });

  it('keeps the last good value when a lookup fails', () => {
    const latest = {
      version: '0.2.2-rc.1',
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
      prerelease: true,
      publishedAt: '2026-11-04T10:00:00Z',
    };
    const next = applyLookupError({ latest, checkedAt: '2026-11-06T00:00:00Z', error: null }, 'boom');
    expect(next.latest).toEqual(latest);
    expect(next.checkedAt).toBe('2026-11-06T00:00:00Z');
    expect(next.error).toBe('boom');
    expect(applyLookupError(next, 'x'.repeat(400)).error?.length ?? 0).toBeLessThanOrEqual(200);
  });
});

describe('latest version service', () => {
  const latestPayload = [
    {
      tag_name: 'dsh-v0.2.2-rc.1',
      draft: false,
      prerelease: true,
      published_at: '2026-11-04T10:00:00Z',
      html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
    },
  ];

  const response = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('fetches the allowlisted endpoint only', () => {
    expect(isAllowedEndpoint(RELEASES_ENDPOINT)).toBe(true);
    expect(isAllowedEndpoint('https://evil.example.com/releases')).toBe(false);
  });

  it('stores a successful lookup and reuses it inside the TTL', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn(async () => response(latestPayload));
    const service = createLatestVersionService({
      cachePath: join(dir, 'cache.json'),
      log: createNullLogger(),
      fetchImpl,
      now: () => Date.parse('2026-11-07T00:00:00Z'),
    });
    const state = await service.refreshIfStale();
    expect(state.latest?.version).toBe('0.2.2-rc.1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await service.refreshIfStale();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(readFileSync(join(dir, 'cache.json'), 'utf8')) as {
      latest: { version: string };
    };
    expect(persisted.latest.version).toBe('0.2.2-rc.1');
  });

  it('keeps working offline and never throws', async () => {
    const dir = tempDir();
    const service = createLatestVersionService({
      cachePath: join(dir, 'cache.json'),
      log: createNullLogger(),
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    const state = await service.refresh();
    expect(state.latest).toBeNull();
    expect(state.error).toContain('offline');
  });

  it('retains the last good value across a failed refresh', async () => {
    const dir = tempDir();
    const cachePath = join(dir, 'cache.json');
    writeFileSync(
      cachePath,
      JSON.stringify({
        latest: {
          version: '0.2.2-rc.1',
          url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
          prerelease: true,
          publishedAt: '2026-11-04T10:00:00Z',
        },
        checkedAt: '2026-11-06T00:00:00Z',
      }),
    );
    const service = createLatestVersionService({
      cachePath,
      log: createNullLogger(),
      fetchImpl: vi.fn(async () => response({ message: 'rate limited' }, 403)),
    });
    const state = await service.refresh();
    expect(state.latest?.version).toBe('0.2.2-rc.1');
    expect(state.error).toContain('403');
  });

  it('rejects oversized responses instead of buffering them', async () => {
    const dir = tempDir();
    const huge = 'x'.repeat(600 * 1024);
    const service = createLatestVersionService({
      cachePath: join(dir, 'cache.json'),
      log: createNullLogger(),
      fetchImpl: vi.fn(async () => new Response(huge, { status: 200 })),
    });
    const state = await service.refresh();
    expect(state.latest).toBeNull();
    expect(state.error).toContain('larger than');
  });

  it('does not send credentials or custom auth headers', async () => {
    const dir = tempDir();
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      return response(latestPayload);
    });
    const service = createLatestVersionService({
      cachePath: join(dir, 'cache.json'),
      log: createNullLogger(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await service.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
