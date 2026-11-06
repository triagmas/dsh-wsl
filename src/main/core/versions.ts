/**
 * DSH version awareness (pure): executable version parsing, SemVer comparison
 * and GitHub release selection. Network and disk live outside this module.
 */
import type { LatestVersionInfo } from '../../shared/types.js';

/** Upstream repository of the DeepSeek Harness releases. */
export const UPSTREAM_REPO = 'deepseek-ai/deepseek-harness';
export const RELEASES_ENDPOINT = `https://api.github.com/repos/${UPSTREAM_REPO}/releases?per_page=20`;
/** Release tags look like `dsh-v0.2.2-rc.1`. */
export const RELEASE_TAG_PREFIX = 'dsh-v';
/** Re-query upstream at most once per cache window. */
export const VERSION_CACHE_TTL_MS = 18 * 60 * 60 * 1000;
/** Small timeout: the footer must never delay or block startup. */
export const VERSION_FETCH_TIMEOUT_MS = 8_000;
/** Cap the response we are willing to read (the payload is a few hundred KB). */
export const VERSION_MAX_BYTES = 512 * 1024;

const SEMVER = '(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+([0-9A-Za-z.-]+))?';
const SEMVER_EXACT = new RegExp(`^${SEMVER}$`);
const SEMVER_ANYWHERE = new RegExp(SEMVER);

/**
 * Extract the version from `dsh --version` output.
 *
 * The CLI prints the bare version today, but a `dsh/0.2.1-rc.5 node/v22` banner
 * or a trailing newline must not break the footer, so the first SemVer token is
 * used and everything else is discarded.
 */
export function parseDshVersion(output: string): string | null {
  const match = SEMVER_ANYWHERE.exec(output.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, ''));
  if (match === null) return null;
  const [full] = match;
  return full.length <= 64 ? full : null;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseSemver(version: string): ParsedVersion | null {
  const match = SEMVER_EXACT.exec(version.trim());
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * SemVer precedence (`1.0.0-rc.2 < 1.0.0`), ignoring build metadata as the spec
 * requires. Unparsable input compares as equal, so the footer never claims an
 * update it cannot justify.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return 0;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return Math.sign(left[key] - right[key]);
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  // A version without a prerelease is greater than one with it.
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const result = compareIdentifiers(leftPart, rightPart);
    if (result !== 0) return result;
  }
  return 0;
}

/** True only when upstream is strictly newer than the installed executable. */
export function isNewer(latest: string, installed: string | null): boolean {
  if (installed === null || installed === '') return false;
  return compareSemver(latest, installed) > 0;
}

export interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  html_url?: unknown;
}

/**
 * Pick the newest published `dsh-v*` release.
 *
 * Drafts are ignored and the tag prefix is required, so unrelated tags in the
 * repository can never be presented as a DSH version. Prereleases are kept: the
 * upstream project publishes prereleases only, and hiding them would leave the
 * footer permanently empty.
 */
export function selectLatestRelease(payload: unknown): LatestVersionInfo | null {
  if (!Array.isArray(payload)) return null;
  let best: { info: LatestVersionInfo; published: number } | null = null;
  for (const entry of payload as GithubRelease[]) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.draft === true) continue;
    if (typeof entry.tag_name !== 'string' || !entry.tag_name.startsWith(RELEASE_TAG_PREFIX)) continue;
    if (typeof entry.html_url !== 'string' || !/^https:\/\/github\.com\//.test(entry.html_url)) continue;
    if (typeof entry.published_at !== 'string') continue;
    const published = Date.parse(entry.published_at);
    if (Number.isNaN(published)) continue;
    const version = entry.tag_name.slice(RELEASE_TAG_PREFIX.length);
    if (parseSemver(version) === null) continue;
    if (best !== null && published <= best.published) continue;
    best = {
      published,
      info: {
        version,
        url: entry.html_url,
        prerelease: entry.prerelease === true,
        publishedAt: entry.published_at,
      },
    };
  }
  return best === null ? null : best.info;
}

export interface VersionCacheState {
  latest: LatestVersionInfo | null;
  checkedAt: string | null;
  error: string | null;
}

/** True when the cached lookup is older than the TTL or never happened. */
export function shouldRefresh(cache: VersionCacheState, now: number, ttlMs = VERSION_CACHE_TTL_MS): boolean {
  if (cache.checkedAt === null) return true;
  const checked = Date.parse(cache.checkedAt);
  if (Number.isNaN(checked)) return true;
  return now - checked >= ttlMs;
}

/**
 * Merge a failed lookup into the cache: the last good value and its timestamp
 * are kept, only the error message is added, so an offline start never erases
 * what the footer already knows.
 */
export function applyLookupError(cache: VersionCacheState, message: string): VersionCacheState {
  return { latest: cache.latest, checkedAt: cache.checkedAt, error: message.slice(0, 200) };
}

export function emptyCache(): VersionCacheState {
  return { latest: null, checkedAt: null, error: null };
}
