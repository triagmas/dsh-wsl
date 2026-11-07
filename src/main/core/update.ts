/**
 * One-click DeepSeek Harness update (issue #12).
 *
 * Everything here is pure: version guards, the isolation checks that decide
 * whether an update is allowed at all, the bounded terminal buffer that the
 * modal window renders and the phase model the UI follows. No Electron, no
 * child processes — the runner in `update-runner.ts` drives the WSL scripts.
 *
 * Safety model:
 * - only an exact published version is accepted (no ranges, tags or shell text);
 * - only the isolated runtime below the configured root may be replaced, never a
 *   global installation, a custom executable or the official Windows app;
 * - the previous install is kept next to the root for rollback.
 */
import { redactSecrets } from '../backend/urls.js';
import { isValidIsolationRoot, joinPosix } from './isolation.js';
import { compareSemver, parseSemver } from './versions.js';

/** How many terminal lines the progress window keeps. */
export const UPDATE_TERMINAL_MAX_LINES = 400;
/** Longest single line kept from the updater output. */
export const UPDATE_TERMINAL_MAX_LINE_LENGTH = 320;

/**
 * An exact release version: `0.2.2`, `0.2.2-rc.1`, never a range or a tag.
 * Deliberately strict — the value ends up as an npm install target.
 */
const EXACT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 44 && EXACT_VERSION.test(value) && parseSemver(value) !== null;
}

/** Strip ANSI escapes, control characters and carriage returns. */
const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * One line as the terminal window may show it.
 *
 * Output comes from npm and from user-installed scripts, so it is treated as
 * untrusted text: escapes and control characters are removed, secrets are
 * redacted and the line is capped. `null` means "nothing to show".
 */
export function sanitizeUpdateLine(raw: string): string | null {
  const cleaned = raw.replace(ANSI, '').replace(CONTROL, '').replace(/\r/g, '').trimEnd();
  if (cleaned.trim() === '') return null;
  const redacted = redactSecrets(cleaned);
  return redacted.length > UPDATE_TERMINAL_MAX_LINE_LENGTH
    ? `${redacted.slice(0, UPDATE_TERMINAL_MAX_LINE_LENGTH - 1)}…`
    : redacted;
}

export interface UpdateTerminal {
  /** Append one raw line; returns the sanitized line when it was kept. */
  append(raw: string): string | null;
  lines(): string[];
  clear(): void;
}

/** Bounded buffer: the terminal window never grows without limit. */
export function createUpdateTerminal(maxLines = UPDATE_TERMINAL_MAX_LINES): UpdateTerminal {
  const kept: string[] = [];
  return {
    append(raw: string): string | null {
      const line = sanitizeUpdateLine(raw);
      if (line === null) return null;
      kept.push(line);
      if (kept.length > maxLines) kept.splice(0, kept.length - maxLines);
      return line;
    },
    lines: () => [...kept],
    clear: () => {
      kept.length = 0;
    },
  };
}

export type UpdatePhase = 'idle' | 'checking' | 'installing' | 'verifying' | 'activating' | 'done' | 'failed';

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: 'Ready',
  checking: 'Checking the published version on npm…',
  installing: 'Installing DeepSeek Harness…',
  verifying: 'Verifying the new installation…',
  activating: 'Activating the new installation…',
  done: 'Update complete',
  failed: 'Update failed',
};

export function describeUpdatePhase(phase: UpdatePhase): string {
  return PHASE_TEXT[phase];
}

/** True while the process is running and the window must stay open. */
export function isUpdateRunning(phase: UpdatePhase): boolean {
  return phase === 'checking' || phase === 'installing' || phase === 'verifying' || phase === 'activating';
}

/** The app may only relaunch after a completed update. */
export function shouldRestartAfterUpdate(phase: UpdatePhase): boolean {
  return phase === 'done';
}

/**
 * Is the executable in use really the copy inside `<root>/runtime`?
 *
 * The configured root may be written as `~/.local/share/wsl-web-shell` while WSL
 * reports an absolute path (`/home/u/.local/share/wsl-web-shell`), so a `~`
 * prefix is matched as a path suffix instead of a string prefix. Anything else
 * (a global install, a different prefix, a custom executable) is rejected: the
 * updater only ever replaces the runtime it can prove it is using.
 */
export function isInsideIsolatedRuntime(resolvedDshPath: string | null, runtimeRoot: string): boolean {
  if (resolvedDshPath === null || resolvedDshPath === '') return false;
  if (!isValidIsolationRoot(runtimeRoot)) return false;
  const runtime = joinPosix(runtimeRoot, 'runtime');
  if (runtime.startsWith('/')) return resolvedDshPath.startsWith(`${runtime}/`);
  // `~/x` and `x` both have to appear as whole segments somewhere in the path.
  const tail = runtime.startsWith('~/') ? runtime.slice(2) : runtime;
  return resolvedDshPath.includes(`/${tail}/`);
}

export interface UpdatePlanInput {
  distro: string;
  /** Exact published version to install. */
  targetVersion: string;
  /** Version of the executable currently in use, `null` when unknown. */
  installedVersion: string | null;
  /** Path the launcher would actually execute inside the distribution. */
  resolvedDshPath: string | null;
  /** Isolation must be enabled: a global installation is never replaced. */
  isolationEnabled: boolean;
  /** Configured root of the isolated environment. */
  runtimeRoot: string;
  /** True when the user pinned a custom executable in Settings. */
  customExecutable: boolean;
}

export interface UpdatePlan {
  distro: string;
  version: string;
  installedVersion: string;
  runtimeRoot: string;
  runtimeDir: string;
  stagingRoot: string;
  /** Filesystem location of the kept previous installation. */
  previousPattern: string;
}

export type UpdatePlanResult = { ok: true; plan: UpdatePlan } | { ok: false; reason: string };

/** Stable reason codes are shown verbatim by the confirmation window. */
export const UPDATE_REASONS = {
  unknownTarget: 'unknown-target',
  invalidVersion: 'invalid-version',
  sameOrOlder: 'not-newer',
  unknownInstalled: 'installed-unknown',
  globalInstallation: 'global-installation',
  customExecutable: 'custom-executable',
  unsafeRoot: 'unsafe-root',
  foreignRuntime: 'foreign-runtime',
} as const;

export function describeUpdateReason(reason: string): string {
  switch (reason) {
    case UPDATE_REASONS.unknownTarget:
      return 'The latest published version is unknown; the GitHub lookup has not completed yet.';
    case UPDATE_REASONS.invalidVersion:
      return 'The published version is not an exact release version, so nothing will be installed.';
    case UPDATE_REASONS.sameOrOlder:
      return 'The published version is not newer than the installed one.';
    case UPDATE_REASONS.unknownInstalled:
      return 'The installed DeepSeek Harness version is unknown; start the backend once and retry.';
    case UPDATE_REASONS.globalInstallation:
      return 'Environment isolation is disabled, so an update would replace a global installation. Enable the isolated environment in Settings first.';
    case UPDATE_REASONS.customExecutable:
      return 'A custom DeepSeek Harness executable is configured in Settings; the app never replaces it.';
    case UPDATE_REASONS.unsafeRoot:
      return 'The isolated runtime root is not a dedicated directory, so it is not updated.';
    case UPDATE_REASONS.foreignRuntime:
      return 'The executable in use is not the one inside the isolated runtime, so there is nothing safe to replace.';
    default:
      return 'This update cannot be started safely.';
  }
}

/**
 * Decide whether the isolated runtime may be replaced by `targetVersion`.
 *
 * Every rejection is a safety decision, not a failure: the caller shows the
 * reason and stops before running anything inside WSL.
 */
export function planUpdate(input: UpdatePlanInput): UpdatePlanResult {
  if (!isExactVersion(input.targetVersion)) return { ok: false, reason: UPDATE_REASONS.invalidVersion };
  if (!input.isolationEnabled) return { ok: false, reason: UPDATE_REASONS.globalInstallation };
  if (input.customExecutable) return { ok: false, reason: UPDATE_REASONS.customExecutable };
  if (!isValidIsolationRoot(input.runtimeRoot)) return { ok: false, reason: UPDATE_REASONS.unsafeRoot };
  if (input.installedVersion === null || !isExactVersion(input.installedVersion)) {
    return { ok: false, reason: UPDATE_REASONS.unknownInstalled };
  }
  if (compareSemver(input.targetVersion, input.installedVersion) <= 0) {
    return { ok: false, reason: UPDATE_REASONS.sameOrOlder };
  }
  const runtimeDir = joinPosix(input.runtimeRoot, 'runtime');
  // The launcher must really be running the copy inside the isolated runtime.
  if (!isInsideIsolatedRuntime(input.resolvedDshPath, input.runtimeRoot)) {
    return { ok: false, reason: UPDATE_REASONS.foreignRuntime };
  }
  return {
    ok: true,
    plan: {
      distro: input.distro,
      version: input.targetVersion,
      installedVersion: input.installedVersion,
      runtimeRoot: input.runtimeRoot,
      runtimeDir,
      stagingRoot: joinPosix(input.runtimeRoot, 'update'),
      previousPattern: joinPosix(input.runtimeRoot, 'update', 'previous-<timestamp>'),
    },
  };
}

export interface UpdateState {
  phase: UpdatePhase;
  /** Version being installed, `null` before a plan exists. */
  targetVersion: string | null;
  installedVersion: string | null;
  /** Short user-facing status, never a secret. */
  message: string;
  /** Actionable detail for a failure (rollback state), `null` while healthy. */
  detail: string | null;
  /** Terminal lines, oldest first, already sanitized. */
  lines: string[];
  updatedAt: string;
}

export function createUpdateState(now: string): UpdateState {
  return {
    phase: 'idle',
    targetVersion: null,
    installedVersion: null,
    message: describeUpdatePhase('idle'),
    detail: null,
    lines: [],
    updatedAt: now,
  };
}

/** Line prefixes the updater script uses to announce its own steps. */
const STEP_MARKERS: { prefix: string; phase: UpdatePhase }[] = [
  { prefix: 'update: verifying', phase: 'verifying' },
  { prefix: 'update: activating', phase: 'activating' },
];

/** Map an updater line to a phase, `null` when the line is plain output. */
export function phaseFromUpdateLine(line: string): UpdatePhase | null {
  for (const marker of STEP_MARKERS) {
    if (line.startsWith(marker.prefix)) return marker.phase;
  }
  return null;
}
