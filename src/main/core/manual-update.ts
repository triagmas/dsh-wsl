/**
 * Manual update instructions (owner decision, issue #12 follow-up).
 *
 * DSH WSL no longer updates the DeepSeek Harness installation itself: it only
 * reports the installed and the published version and, when they differ, the
 * commands the owner runs in a WSL terminal. Nothing here starts, stops or
 * installs anything — the strings are display data, and the renderer copies them
 * to the clipboard.
 *
 * Pure module: no fs, no Electron, no process spawning.
 */
import type { DshInstallation, InstallManager } from './dsh-locate.js';

/** The npm package the manual command installs. */
export const DSH_PACKAGE = '@deepseek-ai/dsh';

/** Exact version syntax; anything else is never placed in a command. */
const EXACT_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;

/** A unit name may appear in a command only when it matches this pattern. */
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/;

export function isExactVersion(value: unknown): value is string {
  return typeof value === 'string' && EXACT_VERSION.test(value);
}

/** Does the installed installation report exactly the published version? */
export function isSameVersion(left: string | null, right: string | null): boolean {
  return left !== null && right !== null && isExactVersion(left) && isExactVersion(right) && left === right;
}

/**
 * Only a real systemd unit may be named in an instruction.
 *
 * The value comes from `/proc/<pid>/cgroup`, but it still crosses a command line
 * in the window, so the strict charset and the `.service` suffix are re-checked
 * here rather than trusted from the probe.
 */
export function isValidUnitName(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && value.endsWith('.service') && UNIT_PATTERN.test(value);
}

/** Which systemd unit serves the backend the app is attached to. */
export interface ManualUpdateUnit {
  scope: 'system' | 'user';
  name: string;
}

/** How the backend serving the window is managed, from the supervisor's view. */
export type ManualUpdateBackend = 'owned' | 'attached' | 'none';

export interface ManualUpdateInput {
  /** Read-only provenance of the executable in use, `null` when unknown. */
  installation: DshInstallation | null;
  /** Exact published version, `null` while the lookup has not succeeded. */
  target: string | null;
  backend: ManualUpdateBackend;
  /** Unit of an attached backend, `null` when it has none or is unknown. */
  unit: ManualUpdateUnit | null;
}

export type ManualUpdateState = 'pending' | 'installed' | 'unknown';

export interface ManualUpdatePlan {
  /** Version the executable reports, `null` when unknown. */
  installed: string | null;
  state: ManualUpdateState;
  /** Commands for the owner to run, in order; empty when unknown. */
  commands: string[];
  /** Explanation shown instead of, or beside, the commands. */
  description: string | null;
}

/** The one install command for the manager that owns the installation. */
function installCommand(manager: InstallManager, version: string): string | null {
  if (manager === 'npm') return `npm install -g ${DSH_PACKAGE}@${version}`;
  if (manager === 'pnpm') return `pnpm add -g ${DSH_PACKAGE}@${version}`;
  return null;
}

function unknown(installed: string | null, description: string): ManualUpdatePlan {
  return { installed, state: 'unknown', commands: [], description };
}

/**
 * Build what the update window shows.
 *
 * The order is deliberate: stop the process that runs the files, install the
 * exact version, start it again. A process the app did not start is never
 * stopped by a command it invents, and a unit never enters a command unless it
 * passed {@link isValidUnitName}. When in doubt the plan shows no command at
 * all: a wrong command is worse than a short explanation.
 */
export function buildManualUpdatePlan(input: ManualUpdateInput): ManualUpdatePlan {
  const installed = input.installation?.version ?? null;
  const target = input.target;

  if (target === null) {
    return unknown(installed, 'The latest published DeepSeek Harness version is not known yet. Check again in a moment.');
  }
  if (!isExactVersion(target)) {
    return unknown(installed, `The published version (${target}) is not an exact version, so no command is shown.`);
  }
  if (input.installation === null) {
    return unknown(installed, 'No DeepSeek Harness installation was found in this WSL distribution.');
  }
  if (installed === null) {
    return unknown(null, 'The installed DeepSeek Harness did not report a version, so the two versions cannot be compared.');
  }
  if (!isExactVersion(installed)) {
    return unknown(installed, `The installed version (${installed}) is not an exact version, so no command is shown.`);
  }
  if (installed === target) {
    return {
      installed,
      state: 'installed',
      commands: [],
      description: `${DSH_PACKAGE} ${installed} is installed.`,
    };
  }

  const install = installCommand(input.installation.manager, target);
  if (install === null) {
    return unknown(
      installed,
      `This installation is not managed by npm or pnpm (manager: ${input.installation.manager}), so the app cannot name the command that would replace it.`,
    );
  }

  if (input.backend === 'owned') {
    return {
      installed,
      state: 'pending',
      commands: [install],
      description:
        'Quit DSH WSL before running this command: the installation is in use by the backend this app started, and the app does not replace it while it runs.',
    };
  }

  if (input.backend === 'attached' && input.unit !== null && !isValidUnitName(input.unit.name)) {
    return {
      installed,
      state: 'pending',
      commands: [install],
      description:
        'The systemd unit that runs the DeepSeek Harness serving this window could not be identified reliably. Stop that process yourself, run the command, then start it again.',
    };
  }

  if (input.backend === 'attached' && input.unit !== null) {
    const prefix = input.unit.scope === 'system' ? 'sudo systemctl' : 'systemctl --user';
    return {
      installed,
      state: 'pending',
      commands: [
        `${prefix} stop ${input.unit.name}`,
        install,
        `${prefix} start ${input.unit.name}`,
      ],
      description: `These commands stop ${input.unit.name}, install the exact version, and start it again. Run them in a WSL terminal.`,
    };
  }

  if (input.backend === 'attached') {
    return {
      installed,
      state: 'pending',
      commands: [install],
      description:
        'The DeepSeek Harness serving this window was not started by systemd. Stop that process yourself, run the command, then start it again.',
    };
  }

  return {
    installed,
    state: 'pending',
    commands: [install],
    description: 'Run this in a WSL terminal, then start the backend again.',
  };
}
