/**
 * Relaunch after a successful update (issues #12 and #14).
 *
 * Two Windows packages are shipped and they need different relaunch targets:
 *
 * - **Portable**: the EXE unpacks itself into a temporary directory, so
 *   `process.execPath` is *not* the file the user started — relaunching it would
 *   start a copy that is deleted as soon as this process exits. The only correct
 *   target is the portable launcher, which electron-builder exposes as
 *   `PORTABLE_EXECUTABLE_FILE`.
 * - **Installed (NSIS)**: the app runs from its installation directory, so
 *   `process.execPath` *is* the file the user started. Relaunching it is correct,
 *   but only after proving that the running build really is the installed
 *   payload (packaged, and the `resources` directory belongs to this executable).
 *   A development run (`electron .`, unpacked tree) must never be relaunched: the
 *   app cannot know what the user started.
 *
 * The decision is pure, so it can be tested without Electron: given the
 * environment and a file-existence probe, it says whether a relaunch is safe or
 * whether the user has to start the app manually (in which case the update must
 * not be reported as "restarting automatically").
 */

export interface RelaunchEnvironment {
  /** `PORTABLE_EXECUTABLE_FILE` of the running portable build, if any. */
  portableExecutableFile: string | null;
  /** `process.execPath` of the running process. */
  execPath: string;
  /** `process.platform`. */
  platform: string;
  /** `app.isPackaged` of the running build. */
  packaged: boolean;
  /** `process.resourcesPath` of the running build. */
  resourcesPath: string;
}

/** Which packaging produced the running build. */
export type RelaunchMode = 'portable' | 'installed';

export interface RelaunchTarget {
  /** Executable that must be started again. */
  execPath: string;
  /** Packaging the running build came from. */
  mode: RelaunchMode;
  /** True when the target is the portable launcher, not the installed EXE. */
  portable: boolean;
}

export type RelaunchFailureReason =
  | 'not-windows'
  | 'portable-not-a-file'
  | 'dev-unpackaged'
  | 'installed-not-a-file'
  | 'installed-ambiguous';

export type RelaunchDecision =
  | { ok: true; target: RelaunchTarget }
  | { ok: false; reason: RelaunchFailureReason };

/** Only a real Windows executable is a valid relaunch target. */
function looksLikeExecutable(path: string): boolean {
  return /\.exe$/i.test(path) && !path.includes('\u0000');
}

/** Normalise separators so Windows paths compare the same on every host. */
function normalise(path: string): string {
  return path.replace(/\//g, '\\').replace(/\\+/g, '\\').replace(/\\$/, '').toLowerCase();
}

function samePath(left: string, right: string): boolean {
  return normalise(left) === normalise(right);
}

/** Parent directory of a Windows path, without relying on the host separator. */
function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = trimmed.lastIndexOf('\\') > trimmed.lastIndexOf('/')
    ? trimmed.lastIndexOf('\\')
    : trimmed.lastIndexOf('/');
  return cut <= 0 ? trimmed : trimmed.slice(0, cut);
}

/**
 * Decide what to start after an update finished.
 *
 * `exists` is injected so the decision can be tested without touching the disk.
 */
export function resolveRelaunchTarget(
  env: RelaunchEnvironment,
  exists: (path: string) => boolean = () => false,
): RelaunchDecision {
  if (env.platform !== 'win32') return { ok: false, reason: 'not-windows' };

  const portable = env.portableExecutableFile;
  if (portable !== null && portable.trim() !== '') {
    // A portable launcher always records its own path: that file is the only
    // trustworthy target, whatever `process.execPath` points at.
    if (!looksLikeExecutable(portable)) return { ok: false, reason: 'portable-not-a-file' };
    if (!exists(portable)) return { ok: false, reason: 'portable-not-a-file' };
    return { ok: true, target: { execPath: portable, mode: 'portable', portable: true } };
  }

  // No portable origin: either an installed build or a development run.
  if (!env.packaged) return { ok: false, reason: 'dev-unpackaged' };
  if (!looksLikeExecutable(env.execPath)) return { ok: false, reason: 'installed-not-a-file' };
  if (!exists(env.execPath)) return { ok: false, reason: 'installed-not-a-file' };
  // The payload that belongs to *this* executable must sit next to it, otherwise
  // the running process does not describe the file we would start again.
  if (!samePath(`${parentOf(env.execPath)}\\resources`, env.resourcesPath)) {
    return { ok: false, reason: 'installed-ambiguous' };
  }
  if (!exists(`${parentOf(env.execPath)}\\resources\\app.asar`)) {
    return { ok: false, reason: 'installed-ambiguous' };
  }
  return { ok: true, target: { execPath: env.execPath, mode: 'installed', portable: false } };
}

/** Message shown in the terminal window when no automatic relaunch is possible. */
export function describeRelaunchFailure(reason: RelaunchFailureReason): string {
  switch (reason) {
    case 'portable-not-a-file':
      return 'The upstream version was installed and verified, but the portable executable could not be found. Start DSH WSL again manually to use the new version.';
    case 'dev-unpackaged':
      return 'The upstream version was installed and verified. This build was not started from a packaged Windows application, so it cannot restart itself: quit and start DSH WSL again to use the new version.';
    case 'installed-not-a-file':
      return 'The upstream version was installed and verified, but the installed executable could not be found. Start DSH WSL again manually to use the new version.';
    case 'installed-ambiguous':
      return 'The upstream version was installed and verified, but this process cannot prove which installed file it belongs to, so it will not restart itself. Start DSH WSL again manually to use the new version.';
    case 'not-windows':
      return 'The upstream version was installed and verified. Automatic restart is only available in the Windows build; start the app again to use the new version.';
  }
}
