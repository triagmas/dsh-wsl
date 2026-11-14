/**
 * Isolated backend environment.
 *
 * The shell never lets the backend fall back to a shared `~/.dsh`, a shared
 * agents root, or the distro-wide PATH. Instead every launch root is derived
 * from one validated directory (`~/.local/share/wsl-web-shell` by default) that
 * holds `DSH_HOME`, `DSH_AGENTS_HOME`, caches, temp files, the test workspace and
 * a scratch `update` directory kept for profile compatibility.
 *
 * Since issue #17 this is **data** isolation only: the executable is the one the
 * WSL distribution already installs, and no private runtime lives here.
 *
 * Pure module: no fs, no Electron, no process spawning.
 */
import { ISOLATION_ROOT_DEFAULT } from '../../shared/types.js';

/** Marker used in the launcher argument list when isolation is disabled. */
export const ISOLATION_DISABLED = '-';

/**
 * Strict charset for isolation paths. It deliberately excludes spaces,
 * quotes, `$`, `=`, `:`, `;` and backslashes, so a value can never be re-parsed
 * by `wsl.exe`, `env` or a shell as anything else than one literal path.
 */
const SAFE_PATH = /^[A-Za-z0-9._~/@+-]+$/;

/**
 * Every isolation root must be a dedicated, application-owned subtree, so at
 * least this many path components below `~` or below `/`. This rejects `/`,
 * `~`, `~/`, `~/x` and `/srv`, which would place `runtime/`, `dsh-home/` and
 * `agents/` next to unrelated data.
 */
export const ISOLATION_ROOT_MIN_DEPTH = 2;

/** Segments that are structural rather than literal directory names. */
const RESERVED_SEGMENTS = new Set(['.', '..']);

interface RootPath {
  /** `home` for `~`-relative values, `absolute` for `/...`. */
  base: 'home' | 'absolute';
  /** Literal segments, never empty. */
  segments: string[];
}

function parseRoot(value: unknown): RootPath | null {
  if (typeof value !== 'string') return null;
  if (value.length < 1 || value.length > 512) return null;
  const trimmed = value.length > 1 && value.endsWith('/') ? value.replace(/\/+$/, '') : value;
  if (trimmed === '' || !SAFE_PATH.test(trimmed)) return null;

  if (trimmed === '~') return { base: 'home', segments: [] };
  if (trimmed.startsWith('~/')) {
    const segments = trimmed.slice(2).split('/');
    if (segments.some((segment) => segment === '' || RESERVED_SEGMENTS.has(segment))) return null;
    return { base: 'home', segments };
  }
  if (!trimmed.startsWith('/')) return null;
  const segments = trimmed.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => RESERVED_SEGMENTS.has(segment))) return null;
  // Reject `//` anywhere: a redundant separator must not hide a component.
  if (trimmed.startsWith('//') || /\/\//.test(trimmed)) return null;
  return { base: 'absolute', segments };
}

/**
 * A usable isolation root: a dedicated subtree at least {@link
 * ISOLATION_ROOT_MIN_DEPTH} levels deep, without structural or empty segments.
 * `/`, `~`, `~/`, `~/x`, `/srv` and any `..`/`.`/`//` form are rejected.
 */
export function isValidIsolationRoot(value: unknown): value is string {
  const parsed = parseRoot(value);
  return parsed !== null && parsed.segments.length >= ISOLATION_ROOT_MIN_DEPTH;
}

/** Canonical form used by the launcher (trailing slashes removed). */
export function normalizeIsolationRoot(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

/** Absolute POSIX path, same charset rules. Used for the resolved node binary. */
export function isValidRuntimeBinary(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && SAFE_PATH.test(value) && !value.split('/').includes('..');
}

/** Join POSIX segments without producing `//` or a trailing slash. */
export function joinPosix(root: string, ...segments: string[]): string {
  const trimmed = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  const rest = segments.filter((segment) => segment !== '');
  return rest.length === 0 ? trimmed : `${trimmed}/${rest.join('/')}`;
}

export interface IsolationPlan {
  /** True when the launcher must isolate the backend environment. */
  enabled: boolean;
  /** Root directory inside the distribution (`~`-relative or absolute). */
  root: string;
  /**
   * Legacy private runtime directory (`<root>/runtime/bin`).
   *
   * No longer created or used (issue #17); kept in the plan so the app can report
   * that an old copy exists without ever selecting it.
   */
  runtimeBin: string;
  /** `DSH_HOME` — harness config, credentials and sessions. */
  dshHome: string;
  /** `DSH_AGENTS_HOME` — keeps the shared `~/.agents` out of the backend. */
  agentsHome: string;
  /** `XDG_CACHE_HOME` — model and CLI caches. */
  cacheHome: string;
  /** `TMPDIR` — process temp files stay inside the root. */
  tempDir: string;
  /** Test workspace used when the configured workspace is the bare `~`. */
  workspace: string;
}

export function buildIsolationPlan(options: { enabled: boolean; root: string }): IsolationPlan {
  const root = normalizeIsolationRoot(options.root === '' ? ISOLATION_ROOT_DEFAULT : options.root);
  if (options.enabled && !isValidIsolationRoot(root)) {
    throw new Error('invalid-isolation-root');
  }
  return {
    enabled: options.enabled,
    root,
    runtimeBin: joinPosix(root, 'runtime', 'bin'),
    dshHome: joinPosix(root, 'dsh-home'),
    agentsHome: joinPosix(root, 'agents'),
    cacheHome: joinPosix(root, 'cache'),
    tempDir: joinPosix(root, 'tmp'),
    workspace: joinPosix(root, 'workspace'),
  };
}

/**
 * Workspace honouring isolation: the bare `~` default means "the sandbox",
 * an explicitly configured path always wins.
 */
export function resolveLaunchWorkspace(configured: string, plan: IsolationPlan): string {
  if (!plan.enabled) return configured;
  if (configured === '~' || configured === '~/') return plan.workspace;
  return configured;
}

/** Fixed launcher argument for the isolation root, validated or disabled. */
export function isolationRootArg(plan: IsolationPlan): string {
  if (!plan.enabled) return ISOLATION_DISABLED;
  if (!isValidIsolationRoot(plan.root)) throw new Error('invalid-isolation-root');
  return plan.root;
}
