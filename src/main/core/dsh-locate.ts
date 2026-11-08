/**
 * Which DeepSeek Harness installation is really running (issue #17).
 *
 * DSH WSL no longer ships or prefers a private copy of `dsh`: the app must launch
 * the same executable an ordinary WSL terminal would launch, and its update
 * feature must change exactly that installation. This module turns the read-only
 * inspection report into a typed description and answers the questions the
 * update policy needs — is this an npm global install, which prefix owns it, is
 * that prefix writable without elevated rights, what version does it report.
 *
 * Pure module: no fs, no Electron, no process spawning.
 */
import { isValidRuntimeBinary } from './isolation.js';

/** Where the launcher found the executable. */
export type DshSource = 'login-shell' | 'path' | 'fallback' | 'custom';

/** How the installation is managed. Only `npm` can be updated by this app. */
export type InstallManager = 'npm' | 'pnpm' | 'unknown';

export interface DshInstallation {
  /** Executable path the launcher runs (may be a shim/symlink). */
  path: string;
  /** `readlink -f` result: the file the package manager really owns. */
  realPath: string;
  /** True when `path` is a symlink or a generated shim. */
  symlink: boolean;
  /** Version reported by the executable, `null` when unparseable. */
  version: string | null;
  manager: InstallManager;
  /** Global prefix reported by the package manager, `null` when unknown. */
  prefix: string | null;
  /** Package directory inside the prefix, `null` when not an npm layout. */
  packageDir: string | null;
  /** True when the prefix can be written without sudo/UAC. */
  writable: boolean;
  /** npm executable that may be used for the update, `null` when missing. */
  npmPath: string | null;
  source: DshSource;
  /** Number of processes running from this installation that the app does not own. */
  foreignProcesses: number;
  /**
   * Real path a **login shell** resolves for `dsh`, `null` when the distribution
   * has no login shell or it resolves nothing.
   *
   * The product promise is that DSH WSL runs the executable an ordinary terminal
   * runs. The inspection records both sides, so the plan can refuse an
   * installation the terminal would not actually use and the post-update check
   * can prove that both resolve to the same file.
   */
  loginShellRealPath: string | null;
  /** Version that login-shell executable reports, `null` when unknown. */
  loginShellVersion: string | null;
}

/** Marker the inspection script prints before every `key=value` line. */
export const INSPECT_MARKER = '__dsh_wsl_inspect__';

const SAFE_MARKER_VALUE = /^[\w./@+-]*$/;

function asPath(value: string): string | null {
  return isValidRuntimeBinary(value) ? value : null;
}

function asCount(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function asManager(value: string): InstallManager {
  return value === 'npm' || value === 'pnpm' ? value : 'unknown';
}

function asSource(value: string): DshSource {
  return value === 'login-shell' || value === 'path' || value === 'custom' ? value : 'fallback';
}

export interface SharedDshReport {
  /** False when the distribution has no `dsh` at all. */
  found: boolean;
  installation: DshInstallation | null;
  /** The legacy private `<root>/runtime/bin/dsh` still exists on disk. */
  legacyRuntimePresent: boolean;
}

/**
 * Parse the inspection report.
 *
 * Unknown or malformed values never become a usable path: a report the app
 * cannot fully trust resolves to `found: false`, so the caller refuses to update
 * instead of guessing which file to overwrite.
 */
export function parseSharedDshReport(text: string): SharedDshReport {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\0/g, '').trim();
    if (!line.startsWith(`${INSPECT_MARKER} `)) continue;
    const body = line.slice(INSPECT_MARKER.length + 1);
    const index = body.indexOf('=');
    if (index <= 0) continue;
    const key = body.slice(0, index);
    const value = body.slice(index + 1).trim();
    if (!/^[a-z]+$/.test(key) || !SAFE_MARKER_VALUE.test(value)) continue;
    fields.set(key, value);
  }

  const legacyRuntimePresent = fields.get('legacy') === 'yes';
  if (fields.get('found') !== 'yes') return { found: false, installation: null, legacyRuntimePresent };

  const path = asPath(fields.get('path') ?? '');
  const realPath = asPath(fields.get('real') ?? '');
  if (path === null || realPath === null) return { found: false, installation: null, legacyRuntimePresent };

  const prefix = asPath(fields.get('prefix') ?? '');
  const packageDir = asPath(fields.get('package') ?? '');
  const npmPath = asPath(fields.get('npm') ?? '');
  const version = (fields.get('version') ?? '') || null;
  const loginShellRealPath = asPath(fields.get('loginreal') ?? '');
  const loginShellVersion = (fields.get('loginversion') ?? '') || null;

  return {
    found: true,
    legacyRuntimePresent,
    installation: {
      path,
      realPath,
      symlink: fields.get('link') === 'yes',
      version,
      manager: asManager(fields.get('manager') ?? ''),
      prefix,
      packageDir,
      writable: fields.get('writable') === 'yes',
      npmPath,
      source: asSource(fields.get('source') ?? ''),
      foreignProcesses: asCount(fields.get('foreign') ?? '0'),
      loginShellRealPath,
      loginShellVersion,
    },
  };
}

/**
 * Is `candidate` inside `directory`?
 *
 * Exact, component-wise containment: `/usr/local/lib/node_modules/@deepseek-ai/dsh-old`
 * is not inside `/usr/local/lib/node_modules/@deepseek-ai/dsh`, and a path that
 * merely starts with the same characters is rejected as well.
 */
export function isInsideDirectory(candidate: string | null, directory: string | null): boolean {
  if (candidate === null || directory === null) return false;
  if (!isValidRuntimeBinary(candidate) || !isValidRuntimeBinary(directory)) return false;
  const base = directory.replace(/\/+$/, '');
  if (candidate === base) return true;
  return candidate.startsWith(`${base}/`);
}

/** Human-readable installation scope for the UI, derived from the npm prefix. */
export function describeInstallScope(prefix: string | null): string {
  if (prefix === null) return 'unknown';
  if (prefix === '/usr/local' || prefix === '/usr') return `system-wide (${prefix})`;
  if (prefix.startsWith('/opt/')) return `system-wide (${prefix})`;
  return `user (${prefix})`;
}

/**
 * Does this installation look like an npm global package of DeepSeek Harness?
 *
 * The executable must be the one npm generated for the package, not a file that
 * happens to carry the same name: `realPath` has to live inside the package
 * directory, and the package directory has to be the expected one below the
 * reported prefix.
 */
export function isNpmGlobalInstallation(installation: DshInstallation): boolean {
  if (installation.manager !== 'npm') return false;
  if (!isInsideDirectory(installation.realPath, installation.packageDir)) return false;
  if (installation.packageDir === null || installation.prefix === null) return false;
  const expected = `${installation.prefix.replace(/\/+$/, '')}/lib/node_modules/@deepseek-ai/dsh`;
  const normalisedPackage = installation.packageDir.replace(/\/+$/, '');
  return normalisedPackage === expected || normalisedPackage === `${installation.prefix.replace(/\/+$/, '')}/node_modules/@deepseek-ai/dsh`;
}

/**
 * Does the ordinary terminal resolve exactly the installation the app runs?
 *
 * `true` when no login shell could be resolved at all (nothing to disagree
 * with), otherwise false unless both sides report the same real path.
 */
export function loginShellAgrees(installation: DshInstallation): boolean {
  if (installation.loginShellRealPath === null) return true;
  return installation.loginShellRealPath === installation.realPath;
}

/** One-line description for logs: never contains tokens or session data. */
export function describeInstallation(installation: DshInstallation): string {
  const version = installation.version ?? 'unknown';
  return `${installation.path} (${version}, ${installation.manager} ${describeInstallScope(installation.prefix)}, source=${installation.source})`;
}
