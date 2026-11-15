/**
 * The console update (beta.13, hardened in beta.14): one linear `bash` script
 * built from the commands the manual update window already shows.
 *
 * Pure module: it builds text and decides what the result means. Spawning the
 * console and waiting for it lives in `src/main/wsl/console.ts`, the app-level
 * orchestration in `src/main/index.ts`.
 *
 * Deliberately not the deleted in-app updater: no snapshots, no journal, no
 * password handling, no rollback automation. The script is short enough to read
 * in the window before the owner clicks the button.
 *
 * What the script can and cannot promise:
 * - it runs the password prompt (`sudo -v`) once, before it changes anything, so
 *   a wrong password stops the run with nothing to undo;
 * - `start` runs after a successful `stop` on every ordinary path, including a
 *   failed install;
 * - a console the owner closes or interrupts is caught by a trap, which tries the
 *   same `start` line — but a window that is gone has no terminal, so `sudo` may
 *   be unable to ask for the password and the service can stay stopped. The trap
 *   then prints the one line the owner has to run.
 */
import type { UpdateRunResult } from '../../shared/types.js';
import type { DshInstallation } from './dsh-locate.js';
import type { ManualUpdatePlan } from './manual-update.js';
import { buildInstallCommand } from './manual-update.js';

/** Where the script writes its log, relative to the owner's home in WSL. */
export const UPDATE_LOG_DIR = '.local/share/wsl-web-shell';

/** A timestamp safe to place inside a path and a shell literal. */
const SAFE_STAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

/** A stop line the script may re-issue: `sudo systemctl stop <unit>`. */
const STOP_LINE = /^(sudo systemctl|systemctl --user) stop [A-Za-z0-9_.@:-]+\.service$/;
/** The matching start line. */
const START_LINE = /^(sudo systemctl|systemctl --user) start [A-Za-z0-9_.@:-]+\.service$/;
/** A command that escalates itself and therefore needs the password prompt first. */
const SUDO_LINE = /^sudo /;

/** A directory that may be quoted into the script's `PATH`. */
const SAFE_DIR = /^\/[A-Za-z0-9_./@+-]{1,300}$/;

/** How many commands the renderer may hand back for comparison. */
const MAX_EXPECTED_COMMANDS = 20;

/** Log path shown to the owner and used by the script (`$HOME` is expanded there). */
export function buildUpdateLogPath(stamp: string): string | null {
  return SAFE_STAMP.test(stamp) ? `~/${UPDATE_LOG_DIR}/update-${stamp}.log` : null;
}

/**
 * The shell literal for that path.
 *
 * `$HOME` has to stay literal in the script so it resolves inside the
 * distribution, not on Windows.
 */
function logLiteral(logPath: string): string {
  return `"$HOME/${UPDATE_LOG_DIR}/${logPath.split('/').pop() ?? 'update.log'}"`;
}

/** The directory of the Node.js the launcher resolved, `null` when unusable. */
function nodeDirectory(nodePath: string | null | undefined): string | null {
  if (typeof nodePath !== 'string') return null;
  const slash = nodePath.lastIndexOf('/');
  if (slash <= 0) return null;
  const dir = nodePath.slice(0, slash);
  return SAFE_DIR.test(dir) && !dir.includes("'") ? dir : null;
}

/** Everything the script needs beyond the command list itself. */
export interface UpdateScriptOptions {
  /**
   * Node.js binary the launcher uses, e.g. `/home/triag/.hermes/node/bin/node`.
   *
   * The console runs `wsl.exe --exec /bin/bash -c`, not a login shell, so the
   * interactive `PATH` (`~/.local/bin`, nvm) is absent and an npm whose shebang
   * is `#!/usr/bin/env node` cannot start. Its directory is prepended, which is
   * the one line the app can verify before it runs anything.
   */
  nodePath?: string | null;
}

/**
 * One bash script that runs the plan's command list exactly once.
 *
 * Rules, in order of importance:
 * - the password is asked once, up front, and a refused password stops the run
 *   before anything is stopped or installed;
 * - each command is echoed before it runs, and everything is teed to the log;
 * - the first failing command decides the exit status, later ones do not run;
 * - when the list is `stop … install … start`, the start line runs on every path
 *   after a successful stop: normal exit, failed install, Ctrl-C, closed window;
 * - the start line is only re-issued where `sudo` can still see a terminal, and
 *   the script prints the line the owner has to run when it cannot;
 * - nothing free-form reaches the script: commands are the validated strings of
 *   the plan, and one containing a quote or a newline refuses the whole script.
 */
export function buildUpdateScript(
  commands: readonly string[],
  logPath: string,
  options: UpdateScriptOptions = {},
): string | null {
  if (commands.length === 0) return null;
  if (!logPath.startsWith(`~/${UPDATE_LOG_DIR}/`)) return null;
  const usable = commands.filter((command) => typeof command === 'string' && command !== '');
  if (usable.length !== commands.length) return null;
  // A single quote would end the literal the command is embedded in; a newline
  // would split one command into two. Neither can come from the plan, so their
  // presence means the caller built something else.
  if (usable.some((command) => command.includes("'") || /[\r\n]/.test(command))) return null;

  const stop = usable.length >= 2 && STOP_LINE.test(usable[0] ?? '') ? (usable[0] as string) : null;
  const last = usable[usable.length - 1] ?? '';
  const start = stop !== null && START_LINE.test(last) ? last : null;
  const middle = usable.slice(stop === null ? 0 : 1, start === null ? usable.length : usable.length - 1);
  const needsSudo = usable.some((command) => SUDO_LINE.test(command));
  const nodeDir = nodeDirectory(options.nodePath);

  const lines: string[] = [
    '#!/bin/bash',
    '# DSH WSL console update: one attempt, the first failure decides the status.',
    `LOG=${logLiteral(logPath)}`,
    'mkdir -p "${LOG%/*}" || true',
    ': >"$LOG" || true',
    'exec > >(tee -a "$LOG") 2>&1',
  ];
  if (nodeDir !== null) {
    // Without this an npm/pnpm with a `#!/usr/bin/env node` shebang cannot start.
    lines.push(`export PATH='${nodeDir}':"$PATH"`);
  }
  lines.push(
    '',
    'fail=0',
    'stopped=0',
    'started=0',
    `START='${start ?? ''}'`,
    '',
    'run() {',
    '  printf \'\\n$ %s\\n\' "$1"',
    '  eval "$1"',
    '  local code=$?',
    '  if [ "$code" -ne 0 ] && [ "$fail" -eq 0 ]; then fail=$code; fi',
    '  return "$code"',
    '}',
    '',
    '# Bring the service back when this script stopped it and never started it.',
    'bring_back() {',
    '  if [ -z "$START" ] || [ "$stopped" -ne 1 ] || [ "$started" -ne 0 ]; then return 0; fi',
    '  started=1',
    '  printf \'\\nStarting the service again...\\n\'',
    '  if ! run "$START"; then',
    '    printf \'\\nThe service is still stopped. A closed window leaves no terminal, so sudo cannot ask for the password.\\nRun this in a WSL terminal:\\n  %s\\n\' "$START"',
    '  fi',
    '}',
    '',
    'on_signal() {',
    '  printf \'\\n[interrupted]\\n\'',
    '  exit 130',
    '}',
    '',
    'trap on_signal INT TERM HUP',
    'trap bring_back EXIT',
  );

  if (needsSudo) {
    // One prompt, before the stop: a wrong password must leave the service alone.
    lines.push('if [ "$fail" -eq 0 ]; then run \'sudo -v\' || true; fi');
  }
  if (stop !== null) {
    lines.push(`if [ "$fail" -eq 0 ]; then if run '${stop}'; then stopped=1; fi; fi`);
  }
  for (const command of middle) {
    lines.push(`if [ "$fail" -eq 0 ]; then run '${command}'; fi`);
  }
  lines.push(
    'bring_back',
    '',
    'printf \'\\nexit code: %s\\nlog: %s\\n\' "$fail" "$LOG"',
    'printf \'Press Enter to close this window...\'',
    'read -r _ 2>/dev/null || true',
    'exit "$fail"',
    '',
  );
  return lines.join('\n');
}

/** What the console reported and what the app read afterwards. */
export interface UpdateConsoleOutcome {
  /** Exit code of the script, `null` when the console could not be started. */
  code: number | null;
  /** Log path inside WSL, as shown to the owner. */
  logPath: string;
  /** Installed version before the run, `null` when unknown. */
  before: string | null;
  /** Installed version read after the run, `null` when it could not be read. */
  after: string | null;
  /** Exact published version the run aimed at. */
  target: string | null;
  /** Installation the rollback command would install into, `null` when unknown. */
  installation: DshInstallation | null;
  /**
   * Supervisor lifecycle state right after the resume, e.g. `READY` or
   * `RECOVERING`, `null` when it could not be read.
   *
   * The message must not claim the backend is back: only this state knows.
   */
  backend: string | null;
}

export type UpdateConsoleResult = UpdateRunResult;

/** Is the backend actually serving again? `HIDDEN_IN_TRAY` is a running app. */
function backendIsUp(backend: string | null): boolean {
  return backend === 'READY' || backend === 'HIDDEN_IN_TRAY';
}

/** The honest tail of every message: did the backend come back? */
function backendNote(backend: string | null): string {
  if (backendIsUp(backend)) return 'The backend is running again.';
  if (backend === null) return 'The backend state is unknown; check the app window.';
  return `The backend is not running yet (${backend}); the app keeps retrying.`;
}

/**
 * Turn the console exit and the re-read versions into what the window says.
 *
 * The version, not the exit code, decides success: npm can exit non-zero after
 * writing the files, and a closed console reports a signal rather than a code.
 * The supervisor state, not the version, decides what is said about the backend.
 */
export function buildUpdateResult(outcome: UpdateConsoleOutcome): UpdateConsoleResult {
  const { code, logPath, before, after, target, installation, backend } = outcome;
  const success = after !== null && target !== null && after === target;
  const rollbackCommand =
    success || installation === null || before === null ? null : buildInstallCommand(installation, before);

  let message: string;
  if (success) {
    message = `DeepSeek Harness ${after} is installed. ${backendNote(backend)}`;
  } else if (code === null) {
    message = 'The console could not be started. Nothing was changed.';
  } else if (after === null) {
    message = `The console closed with code ${code}, and the installed version could not be read. See the log. ${backendNote(backend)}`;
  } else if (after === before) {
    message = `The console closed with code ${code} and the installation was not changed (still ${after}). See the log. ${backendNote(backend)}`;
  } else {
    message = `The console closed with code ${code}; the installation reports ${after} instead of ${target}. See the log. ${backendNote(backend)}`;
  }

  return {
    success,
    code,
    installed: after,
    target,
    logPath,
    rollbackCommand,
    message,
  };
}

/** Does this plan belong in a console at all? Mirrors `plan.runInConsole`. */
export function planRunsInConsole(plan: ManualUpdatePlan): boolean {
  return plan.runInConsole && plan.state === 'pending' && plan.commands.length > 0;
}

/**
 * Read the command list the window believes it is running.
 *
 * `null` means the payload is not a list of plausible command strings, so the
 * run is refused rather than compared against something the window never showed.
 */
export function asCommandList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EXPECTED_COMMANDS) return null;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item.length > 400) return null;
    if (/[\r\n]/.test(item)) return null;
    list.push(item);
  }
  return list;
}

/**
 * Is the plan rebuilt on click still the list the window showed?
 *
 * The window renders a probe, then the owner may wait: a service could start or
 * stop, a release could appear. Running a different list than the one on screen
 * would be a silent surprise, so the window re-reads instead.
 */
export function sameCommands(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((command, index) => command === right[index]);
}
