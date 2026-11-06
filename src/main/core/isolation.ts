/**
 * Isolated backend environment.
 *
 * The shell never lets the backend fall back to a shared `~/.dsh`, a shared
 * agents root, or the distro-wide PATH. Instead every launch root is derived
 * from one validated directory (`~/.local/share/wsl-web-shell` by default) that
 * holds the private runtime, `DSH_HOME`, `DSH_AGENTS_HOME`, caches, temp files
 * and the test workspace.
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

export function isValidIsolationRoot(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 1 || value.length > 512) return false;
  if (!(value === '~' || value.startsWith('~/') || value.startsWith('/'))) return false;
  if (!SAFE_PATH.test(value)) return false;
  return !value.split('/').includes('..');
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
  /** Private npm prefix / runtime binaries (isolated `dsh` install lives here). */
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

function trimRoot(root: string): string {
  return root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
}

export function buildIsolationPlan(options: { enabled: boolean; root: string }): IsolationPlan {
  const root = trimRoot(options.root === '' ? ISOLATION_ROOT_DEFAULT : options.root);
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
