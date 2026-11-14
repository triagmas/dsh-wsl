/**
 * DeepSeek Harness update policy, phase model, terminal buffer and journal
 * (issues #12 and #17).
 *
 * Issue #17 changed what an update *is*: DSH WSL now runs the `dsh` the selected
 * WSL distribution already has, so the in-app update must change **that shared
 * installation** — the same executable an ordinary `dsh web` in a terminal uses.
 * There is no app-private runtime any more.
 *
 * Everything here is pure: version guards, the provenance checks that decide
 * whether an update is allowed at all, the bounded terminal buffer that the
 * modal window renders, the phase model the UI follows and the transaction
 * journal that makes an interrupted update recoverable. No Electron, no child
 * processes — `update-runner.ts` drives the WSL scripts with these decisions.
 *
 * Safety model:
 * - only an exact published version is accepted (no ranges, tags or shell text),
 *   and the installed version is compared exactly, never as a substring;
 * - an update is allowed only for an **npm global** installation whose executable
 *   really lives inside the reported package directory, whose prefix is writable
 *   without elevated rights and whose version is the one the launcher resolved;
 * - a pinned custom executable, an unknown package manager (pnpm, distro package,
 *   standalone binary), a foreign runtime, a non-writable prefix and any other
 *   `dsh` process running from that installation all fail closed with an
 *   actionable message instead of a risky mutation;
 * - the previous exact version stays installable, and a journal written before
 *   the install makes an interrupted update recoverable on the next start.
 */
import { redactSecrets } from '../backend/urls.js';
import {
  describeInstallScope,
  isInsideDirectory,
  isNpmGlobalInstallation,
  loginShellAgrees,
  type DshInstallation,
} from './dsh-locate.js';
import { compareSemver, parseSemver } from './versions.js';

/** How many terminal lines the progress window keeps. */
export const UPDATE_TERMINAL_MAX_LINES = 400;
/** Longest single line kept from the updater output. */
export const UPDATE_TERMINAL_MAX_LINE_LENGTH = 320;

/** How much of the backup script's own wording a failure message keeps. */
export const BACKUP_REASON_MAX_LENGTH = 200;

/**
 * An exact release version: `0.2.2`, `0.2.2-rc.1`, never a range or a tag.
 * Deliberately strict — the value ends up as an npm install target.
 */
const EXACT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 44 && EXACT_VERSION.test(value) && parseSemver(value) !== null;
}

/**
 * Two version strings are the same release.
 *
 * `0.2.2-rc.1` and `0.2.2-rc.10` are different releases, so this is a strict
 * comparison of the normalised strings — not a `startsWith`/substring test.
 */
export function isSameVersion(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  const a = parseSemver(left.trim().replace(/^v/, ''));
  const b = parseSemver(right.trim().replace(/^v/, ''));
  if (a === null || b === null) return false;
  return compareSemver(left.trim(), right.trim()) === 0;
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

/**
 * One line of backup-script output as a failure message may show it.
 *
 * The snapshot step is allowed to explain itself (a missing Node runtime, a
 * redirected package directory, an incomplete copy), but its output is
 * untrusted text from a subprocess. It goes through the same sanitizer the
 * terminal uses — ANSI escapes and control characters removed, credentials
 * redacted, hard length bound — before it can reach `UpdateState.detail`.
 * `null` means "nothing usable was printed", so the caller substitutes a
 * bounded fallback instead of an empty parenthesis.
 */
export function sanitizeBackupReason(raw: string): string | null {
  const line = sanitizeUpdateLine(raw);
  if (line === null) return null;
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length > BACKUP_REASON_MAX_LENGTH
    ? `${collapsed.slice(0, BACKUP_REASON_MAX_LENGTH - 1)}…`
    : collapsed;
}

/**
 * The one line of a failed backup step that the UI and the log may show.
 *
 * Subprocess output is untrusted text: the last non-empty line is picked (the
 * earlier ones are usually progress noise), then sanitized like terminal output.
 * Empty string means nothing usable was printed.
 */
export function backupFailureDetail(stdout: string, stderr: string): string {
  const source = stderr.trim() === '' ? stdout : stderr;
  const line = source
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(-1)[0] ?? '';
  return sanitizeUpdateLine(line) ?? '';
}

export interface UpdateTerminal {
  /** Append one raw line; returns the sanitized line when it was kept. */
  append(raw: string): string | null;
  lines(): string[];
  /** How many lines were dropped from the front because of the cap. */
  dropped(): number;
  clear(): void;
}

/** Bounded buffer: the terminal window never grows without limit. */
export function createUpdateTerminal(maxLines = UPDATE_TERMINAL_MAX_LINES): UpdateTerminal {
  const kept: string[] = [];
  let dropped = 0;
  return {
    append(raw: string): string | null {
      const line = sanitizeUpdateLine(raw);
      if (line === null) return null;
      kept.push(line);
      if (kept.length > maxLines) {
        const excess = kept.length - maxLines;
        kept.splice(0, excess);
        dropped += excess;
      }
      return line;
    },
    lines: () => [...kept],
    dropped: () => dropped,
    clear: () => {
      kept.length = 0;
      dropped = 0;
    },
  };
}

/**
 * What the terminal window has to do with a newly published state.
 *
 * `dropped` grows as soon as the rolling cap starts discarding lines, so a
 * renderer that only appends would freeze at 400 lines. Comparing the last seen
 * `dropped` with the current one tells it when the whole buffer has to be
 * rebuilt, and everything else can still be appended.
 */
export function planTerminalUpdate(
  state: { lines: string[]; dropped: number },
  seen: { dropped: number; rendered: number },
): { rebuild: boolean; append: string[]; rendered: number } {
  if (state.dropped !== seen.dropped) {
    // The rolling cap discarded lines: the whole buffer has to be redrawn.
    return { rebuild: true, append: [...state.lines], rendered: state.lines.length };
  }
  const append = state.lines.slice(seen.rendered);
  return { rebuild: false, append, rendered: seen.rendered + append.length };
}

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'inspecting'
  | 'stopping'
  | 'installing'
  | 'verifying'
  | 'starting'
  | 'done'
  | 'failed'
  | 'rolled-back';

const PHASE_TEXT: Record<UpdatePhase, string> = {
  idle: 'Ready',
  checking: 'Checking the published version on npm…',
  inspecting: 'Checking the DeepSeek Harness installation…',
  stopping: 'Stopping the app-owned backend…',
  installing: 'Updating DeepSeek Harness in WSL…',
  verifying: 'Verifying the updated installation…',
  starting: 'Starting DeepSeek Harness…',
  done: 'Update complete',
  failed: 'Update failed',
  'rolled-back': 'Update failed, previous version restored',
};

export function describeUpdatePhase(phase: UpdatePhase): string {
  return PHASE_TEXT[phase];
}

/** True while the process is running and the window must stay open. */
export function isUpdateRunning(phase: UpdatePhase): boolean {
  return (
    phase === 'checking' ||
    phase === 'inspecting' ||
    phase === 'stopping' ||
    phase === 'installing' ||
    phase === 'verifying' ||
    phase === 'starting'
  );
}

/**
 * Phases during which the app must not quit.
 *
 * `checking` only reads the published version from npm, so quitting there leaves
 * nothing behind. From `inspecting` the run writes the verified recovery
 * snapshot of the current installation into the app data root; killing that copy
 * leaves a partial backup. From `stopping` to `starting` the shared WSL
 * installation itself is being replaced or the new backend is starting, and
 * interrupting that is exactly what the journal recovery would have to repair.
 * The app therefore refuses to quit from `inspecting` onward.
 */
export function isUpdateCritical(phase: UpdatePhase): boolean {
  return (
    phase === 'inspecting' ||
    phase === 'stopping' ||
    phase === 'installing' ||
    phase === 'verifying' ||
    phase === 'starting'
  );
}

export type QuitTrigger = 'user' | 'session-end';

/**
 * Whether a quit request must be refused.
 *
 * The critical-phase guard exists to protect the recovery snapshot and the shared
 * installation from a user-initiated quit. A Windows logoff/shutdown cannot be
 * refused: the OS terminates the process after a short grace period, so blocking
 * there only removes the chance to stop the owned backend and write the
 * clean-shutdown marker. The session-end path therefore exits best effort and
 * leaves the journal for the next start to recover from.
 */
export function shouldRefuseQuit(trigger: QuitTrigger, phase: UpdatePhase, running: boolean): boolean {
  return trigger === 'user' && running && isUpdateCritical(phase);
}

/** The app may only relaunch after a completed update. */
export function shouldRestartAfterUpdate(phase: UpdatePhase): boolean {
  return phase === 'done';
}


/** Reject any path that is not a plain, normalised POSIX absolute path. */
export function isNormalisedAbsolutePath(candidate: unknown): candidate is string {
  if (typeof candidate !== 'string' || candidate.length > 4096) return false;
  return (
    candidate.startsWith('/') &&
    !candidate.endsWith('/') &&
    !candidate.includes('//') &&
    !candidate.includes('/./') &&
    !candidate.endsWith('/.') &&
    !candidate.includes('/../') &&
    !candidate.endsWith('/..') &&
    candidate !== '/'
  );
}

export interface SharedUpdatePlanInput {
  distro: string;
  /** Exact published version to install. */
  targetVersion: string;
  /** App data root used for the npm cache and the backup copy, `-` when off. */
  appRoot: string;
  /** What the inspection reported for the installation the launcher uses. */
  installation: DshInstallation;
  /** True when the user pinned a custom executable in Settings. */
  customExecutable: boolean;
  /**
   * The backend the app is attached to and can stop through its own manager, if
   * any. Its own process is not "another session": it is the one this update is
   * about to stop, so it does not block the plan.
   */
  stoppablePid?: number | null;
}

export interface SharedUpdatePlan {
  distro: string;
  appRoot: string;
  version: string;
  installedVersion: string;
  /** Executable the launcher runs (as resolved, may be a shim). */
  dshPath: string;
  /** `readlink -f` of that executable: the file npm really owns. */
  realPath: string;
  /**
   * The attached backend this plan is allowed to stop, `null` when none. Carried
   * through the plan so the runner's re-check agrees with the first decision.
   */
  stoppablePid: number | null;
  /** npm global prefix, verified by `npm prefix -g` inside the script. */
  prefix: string;
  packageDir: string;
  npmPath: string;
  /** Human-readable scope for the confirmation window. */
  scope: string;
}

export type SharedUpdatePlanResult =
  | { ok: true; plan: SharedUpdatePlan }
  | { ok: false; reason: string; detail: string | null };

/** Stable reason codes are shown verbatim by the confirmation window. */
export const UPDATE_REASONS = {
  unknownTarget: 'unknown-target',
  invalidVersion: 'invalid-version',
  sameOrOlder: 'not-newer',
  unknownInstalled: 'installed-unknown',
  missingInstallation: 'missing-installation',
  customExecutable: 'custom-executable',
  unsupportedManager: 'unsupported-manager',
  foreignRuntime: 'foreign-runtime',
  notWritable: 'not-writable',
  foreignProcess: 'foreign-process',
  noNpm: 'no-npm',
  loginShellMismatch: 'login-shell-mismatch',
  // Part of the published reason catalogue. The runner now describes a failed
  // snapshot with the code and output of the script itself
  // (`describeBackupFailure`); this entry stays as generic wording for callers
  // that have no script output yet.
  backupUnavailable: 'backup-unavailable',
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
    case UPDATE_REASONS.missingInstallation:
      return 'No DeepSeek Harness executable was found in this WSL distribution.';
    case UPDATE_REASONS.customExecutable:
      return 'A custom DeepSeek Harness executable is pinned in Settings. The app only updates the installation npm manages for your WSL user; clear the path in Settings to update in-app.';
    case UPDATE_REASONS.unsupportedManager:
      return 'This DeepSeek Harness installation is not managed by npm (for example pnpm, a distro package or a standalone binary), so the app will not modify it. Update it with the tool that installed it.';
    case UPDATE_REASONS.foreignRuntime:
      return 'The executable in use is not the one inside the reported npm package, so there is nothing this app can safely update.';
    case UPDATE_REASONS.notWritable:
      return 'The npm prefix of this installation is not writable without elevated rights. Run the update yourself with the command shown, or reinstall DeepSeek Harness for your user (npm prefix in your home directory). The app never uses sudo or UAC.';
    case UPDATE_REASONS.foreignProcess:
      return 'Another DeepSeek Harness process is running from this installation. Close it (including any `dsh web` started in a terminal) and try again: the app never stops processes it does not own.';
    case UPDATE_REASONS.noNpm:
      return 'npm was not found in this WSL distribution, so the installation cannot be updated from the app.';
    case UPDATE_REASONS.loginShellMismatch:
      return 'An ordinary WSL login shell does not resolve the same DeepSeek Harness executable this app runs (or cannot report its version), so updating would not change the CLI you use in a terminal. Make sure `bash -lc "command -v dsh"` prints the installation you expect, fix the PATH order in your shell profile, or clear a pinned path in Settings, then try again.';
    case UPDATE_REASONS.backupUnavailable:
      return 'The verified recovery snapshot could not be created, so nothing was changed. Check the free space and write access of the app data directory inside WSL and retry.';
    default:
      return 'This update cannot be started safely.';
  }
}

/**
 * Explain a failed snapshot attempt with the real reason.
 *
 * The backup script already reports the actionable cause on stderr (an empty
 * version probe, a redirected package directory, an incomplete copy, a
 * non-writable snapshot directory). Passing that through is what turns a generic
 * "Update failed" into something the user can act on; the free-space advice is
 * only one of several possible causes, so it is no longer assumed (issue #27).
 */
export function describeBackupFailure(code: number | null, detail: string | null): string {
  const exit = code === null ? 'no exit status' : `exit code ${code}`;
  // Sanitized here as well as where the text enters the app: the bound and the
  // redaction must hold even for a caller that passes raw subprocess output.
  const reason = detail === null ? null : sanitizeBackupReason(detail);
  return (
    `The verified recovery snapshot could not be created (${exit}: ${
      reason === null ? 'the backup step printed no explanation' : reason
    }), so nothing was changed. Your DeepSeek Harness CLI was not modified.`
  );
}

/** The npm command the user can run manually when the app refuses. */
export function manualUpdateCommand(plan: { npmPath: string | null; prefix: string | null } | null, version: string): string {
  const npm = plan?.npmPath ?? 'npm';
  const prefix = plan?.prefix ?? null;
  return prefix === null || prefix === ''
    ? `${npm} install -g @deepseek-ai/dsh@${version}`
    : `${npm} install -g --prefix ${prefix} @deepseek-ai/dsh@${version}`;
}

/**
 * Decide whether the shared installation may be updated to `targetVersion`.
 *
 * Every rejection is a safety decision, not a failure: the caller shows the
 * reason and stops before running anything that writes inside WSL.
 */
export function planSharedUpdate(input: SharedUpdatePlanInput): SharedUpdatePlanResult {
  const { installation } = input;
  if (!isExactVersion(input.targetVersion)) return { ok: false, reason: UPDATE_REASONS.invalidVersion, detail: null };
  if (input.customExecutable) return { ok: false, reason: UPDATE_REASONS.customExecutable, detail: installation.path };
  if (installation.version === null || !isExactVersion(installation.version)) {
    return { ok: false, reason: UPDATE_REASONS.unknownInstalled, detail: installation.path };
  }
  if (compareSemver(input.targetVersion, installation.version) <= 0) {
    return { ok: false, reason: UPDATE_REASONS.sameOrOlder, detail: null };
  }
  if (installation.manager !== 'npm') {
    return { ok: false, reason: UPDATE_REASONS.unsupportedManager, detail: `${installation.path} (${installation.manager})` };
  }
  if (
    !isNpmGlobalInstallation(installation) ||
    !isInsideDirectory(installation.realPath, installation.packageDir) ||
    !isNormalisedAbsolutePath(installation.prefix) ||
    !isNormalisedAbsolutePath(installation.realPath)
  ) {
    return { ok: false, reason: UPDATE_REASONS.foreignRuntime, detail: installation.realPath };
  }
  if (installation.npmPath === null) return { ok: false, reason: UPDATE_REASONS.noNpm, detail: null };
  if (!installation.writable) {
    return { ok: false, reason: UPDATE_REASONS.notWritable, detail: installation.prefix };
  }
  // Every process running from this installation blocks the update, except the
  // managed backend the app verified it can stop. A list, not a count: with only
  // a number, "one other session" and "my own attached backend" look identical.
  const stoppable = input.stoppablePid ?? null;
  const blocking = installation.foreignPids.filter((pid) => pid !== stoppable);
  if (blocking.length > 0 || installation.foreignProcesses > installation.foreignPids.length) {
    // A count larger than the list means the scan hit its own limit: refuse
    // rather than install while an unlisted process still holds the files.
    const detail = `${Math.max(blocking.length, installation.foreignProcesses - installation.foreignPids.length)}`;
    return { ok: false, reason: UPDATE_REASONS.foreignProcess, detail };
  }
  // The product promise: the app runs, and updates, the executable a terminal
  // runs. A login shell that resolves another file makes that impossible.
  if (!loginShellAgrees(installation)) {
    return {
      ok: false,
      reason: UPDATE_REASONS.loginShellMismatch,
      detail:
        installation.loginShellRealPath === null
          ? 'a login shell does not resolve dsh at all'
          : `${installation.loginShellRealPath} (${installation.loginShellVersion ?? 'no version'})`,
    };
  }
  return {
    ok: true,
    plan: {
      stoppablePid: input.stoppablePid ?? null,
      distro: input.distro,
      appRoot: input.appRoot,
      version: input.targetVersion,
      installedVersion: installation.version,
      dshPath: installation.path,
      realPath: installation.realPath,
      prefix: installation.prefix ?? '',
      packageDir: installation.packageDir ?? '',
      npmPath: installation.npmPath,
      scope: describeInstallScope(installation.prefix),
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
  /** Lines dropped from the front of `lines` because of the cap. */
  dropped: number;
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
    dropped: 0,
    updatedAt: now,
  };
}

/** Line prefixes the updater script uses to announce its own steps. */
const STEP_MARKERS: { prefix: string; phase: UpdatePhase }[] = [
  { prefix: 'update: installing', phase: 'installing' },
  { prefix: 'update: verifying', phase: 'verifying' },
];

/** Map an updater line to a phase, `null` when the line is plain output. */
export function phaseFromUpdateLine(line: string): UpdatePhase | null {
  for (const marker of STEP_MARKERS) {
    if (line.startsWith(marker.prefix)) return marker.phase;
  }
  return null;
}

// --- transaction journal ---------------------------------------------------

/**
 * Where an update was when the app last looked.
 *
 * The journal is written **before** the shared installation is touched, so a
 * crash, a forced quit or a killed npm cannot leave the app guessing on the next
 * start. Version 2 describes a shared npm installation (issue #17); version 1 is
 * the retired private-runtime swap and is only read, never written, so a profile
 * written by an older build is handled explicitly instead of being ignored.
 */
export type UpdateJournalPhase = 'updating' | 'verifying';

export interface UpdateJournalV2 {
  version: 2;
  kind: 'npm-global';
  transaction: string;
  phase: UpdateJournalPhase;
  distro: string;
  /** Executable the launcher uses. */
  dshPath: string;
  /** `readlink -f` of that executable. */
  realPath: string;
  prefix: string;
  packageDir: string;
  /** App data root inside the distribution (`-` when isolation is off). */
  appRoot: string;
  /** npm used for the update, needed to restore after an interruption. */
  npmPath: string;
  /**
   * Verified offline recovery snapshot created before the installation changed.
   * Recovery restores from it without asking the registry for anything.
   */
  backupDir: string;
  target: string;
  installed: string;
  startedAt: string;
  updatedAt: string;
}

/** Journal written by the retired isolated-runtime updater (issue #12). */
export interface LegacyUpdateJournalV1 {
  version: 1;
  transaction: string;
  phase: 'staging' | 'activating' | 'verifying-backend';
  distro: string;
  runtimeRoot: string;
  canonicalRoot: string;
  target: string;
  installed: string;
  startedAt: string;
  updatedAt: string;
}

export type UpdateJournal = UpdateJournalV2 | LegacyUpdateJournalV1;

const JOURNAL_PHASES: UpdateJournalPhase[] = ['updating', 'verifying'];
const LEGACY_PHASES: LegacyUpdateJournalV1['phase'][] = ['staging', 'activating', 'verifying-backend'];
const TRANSACTION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,31}$/;

/** A transaction id that is safe both as a path segment and as an argv value. */
export function createTransactionId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `${stamp}-${suffix}`.replace(/[^0-9A-Za-z-]/g, '');
}

export function isValidTransactionId(value: unknown): value is string {
  return typeof value === 'string' && TRANSACTION_ID.test(value);
}

function requiredString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' && field.length > 0 && field.length <= 4096 ? field : null;
}

/**
 * The WSL gateway also accepts a home-relative app root (for example
 * ~/.local/share/wsl-web-shell). Preserve that exact representation in a
 * recovery journal: expanding it on Windows would use the wrong home directory.
 * All other paths in a v2 journal are required to be absolute.
 */
function isJournalAppRoot(value: string): boolean {
  if (value === '-') return true;
  if (!value.startsWith('~/')) return isNormalisedAbsolutePath(value);
  // Reuse the absolute-path normalization rules for the part after the tilde,
  // and reject control characters and backslashes in the home-relative form.
  return isNormalisedAbsolutePath(value.slice(1)) &&
    !/[\x00-\x1f\x7f\\]/.test(value);
}

/** Validate a journal read back from disk; anything odd means "no journal". */
export function parseUpdateJournal(raw: unknown): UpdateJournal | null {
  if (raw === null || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const transaction = requiredString(value, 'transaction');
  const distro = requiredString(value, 'distro');
  const target = requiredString(value, 'target');
  const installed = requiredString(value, 'installed');
  const startedAt = requiredString(value, 'startedAt');
  const updatedAt = requiredString(value, 'updatedAt');
  if (
    transaction === null ||
    distro === null ||
    target === null ||
    installed === null ||
    startedAt === null ||
    updatedAt === null ||
    !isValidTransactionId(transaction) ||
    !isExactVersion(target) ||
    !isExactVersion(installed)
  ) {
    return null;
  }

  if (value.version === 2) {
    const dshPath = requiredString(value, 'dshPath');
    const realPath = requiredString(value, 'realPath');
    const prefix = requiredString(value, 'prefix');
    const packageDir = requiredString(value, 'packageDir');
    const appRoot = requiredString(value, 'appRoot');
    const npmPath = requiredString(value, 'npmPath');
    const backupDir = requiredString(value, 'backupDir');
    if (value.kind !== 'npm-global') return null;
    if (!JOURNAL_PHASES.includes(value.phase as UpdateJournalPhase)) return null;
    if (
      dshPath === null ||
      realPath === null ||
      prefix === null ||
      packageDir === null ||
      appRoot === null ||
      npmPath === null ||
      backupDir === null ||
      !isNormalisedAbsolutePath(npmPath) ||
      !isNormalisedAbsolutePath(backupDir) ||
      !isJournalAppRoot(appRoot) ||
      !isNormalisedAbsolutePath(dshPath) ||
      !isNormalisedAbsolutePath(realPath) ||
      !isNormalisedAbsolutePath(prefix) ||
      !isNormalisedAbsolutePath(packageDir)
    ) {
      return null;
    }
    return {
      version: 2,
      kind: 'npm-global',
      transaction,
      phase: value.phase as UpdateJournalPhase,
      distro,
      dshPath,
      realPath,
      prefix,
      packageDir,
      appRoot,
      npmPath,
      backupDir,
      target,
      installed,
      startedAt,
      updatedAt,
    };
  }

  if (value.version === 1) {
    const runtimeRoot = requiredString(value, 'runtimeRoot');
    const canonicalRoot = requiredString(value, 'canonicalRoot');
    if (!LEGACY_PHASES.includes(value.phase as LegacyUpdateJournalV1['phase'])) return null;
    if (runtimeRoot === null || canonicalRoot === null || !isNormalisedAbsolutePath(canonicalRoot)) return null;
    return {
      version: 1,
      transaction,
      phase: value.phase as LegacyUpdateJournalV1['phase'],
      distro,
      runtimeRoot,
      canonicalRoot,
      target,
      installed,
      startedAt,
      updatedAt,
    };
  }

  return null;
}

/**
 * The journal file exists but cannot be used.
 *
 * A missing file is a normal start; an unreadable or corrupt file is not: the app
 * cannot know whether an install happened, so it must not start anything.
 */
export class UpdateJournalError extends Error {
  constructor(
    readonly reason: 'corrupt' | 'unreadable',
    readonly path: string,
    detail: string,
  ) {
    super(
      `The update journal at ${path} is ${reason === 'corrupt' ? 'corrupt' : 'unreadable'}${detail === '' ? '' : ` (${detail})`}`,
    );
    this.name = 'UpdateJournalError';
  }
}

/**
 * Persistence for the transaction journal (a file in the app profile).
 *
 * `read()` returns `null` **only** when there is no journal at all. A file that
 * exists but cannot be read or validated throws `UpdateJournalError`: treating
 * that as "nothing happened" would start DeepSeek Harness on top of an
 * installation whose state is unknown.
 */
/**
 * How many verified recovery snapshots are kept on disk.
 *
 * A snapshot is deleted only by the transaction that owns it, and a rollback
 * always uses the snapshot of its own transaction, so older copies add disk use
 * instead of safety. Two leaves one manual fallback for the owner without letting
 * a habit of updating grow the app data root without bound.
 */
export const SNAPSHOT_RETENTION = 2;

export interface UpdateJournalStore {
  read(): UpdateJournal | null;
  write(journal: UpdateJournalV2): void;
  clear(): void;
}

/** What the shared installation looks like now, as the inspection reported it. */
export interface SharedInstallObservation {
  /** The executable still exists and is executable. */
  present: boolean;
  /** Version it reports, `null` when unknown. */
  version: string | null;
  /** Real path it resolves to, `null` when missing. */
  realPath: string | null;
}

/**
 * What to do about a journal that outlived its update.
 *
 * - `finalize`: the shared installation already reports the target version, so
 *   the update really finished before the app died — keep it.
 * - `abandon`: it still reports the version from before the update — nothing was
 *   changed (or the restore already ran), so forget the record.
 * - `rollback`: it reports something else, or is missing while npm still can
 *   reinstall the previous version — restore the previous exact version.
 * - `blocked`: nothing can be restored safely; the caller must not start
 *   anything and has to explain the state instead of guessing.
 */
export type RecoveryAction = 'finalize' | 'rollback' | 'abandon' | 'blocked' | 'legacy';

export interface RecoveryDecision {
  action: RecoveryAction;
  reason: string;
}

export function decideRecovery(
  journal: UpdateJournal,
  observation: SharedInstallObservation,
): RecoveryDecision {
  if (journal.version === 1) {
    return {
      action: 'legacy',
      reason: 'the journal describes the retired private runtime, which this build no longer starts',
    };
  }
  if (observation.present && isSameVersion(observation.version, journal.target)) {
    // The target version must also be the file the plan approved: a target
    // version that appeared at another path is not the update that was started.
    if (observation.realPath !== null && observation.realPath !== journal.realPath) {
      return {
        action: 'rollback',
        reason: `the installation reports ${journal.target} but resolves to ${observation.realPath} instead of ${journal.realPath}`,
      };
    }
    return { action: 'finalize', reason: `the installation already reports ${journal.target}` };
  }
  if (observation.present && isSameVersion(observation.version, journal.installed)) {
    return { action: 'abandon', reason: `the installation still reports ${journal.installed}` };
  }
  if (observation.present && observation.version === null) {
    // An unobservable version (for example missing Node on PATH) does not
    // establish corruption. Preserving the journal is safer than deleting an
    // intact package to attempt rollback.
    return {
      action: 'blocked',
      reason: 'the installation is present but did not report a verifiable version',
    };
  }
  if (observation.present) {
    return {
      action: 'rollback',
      reason: `the installation reports ${observation.version}, expected ${journal.target} or ${journal.installed}`,
    };
  }
  return { action: 'rollback', reason: 'the installation is missing, so the previous version is reinstalled' };
}
