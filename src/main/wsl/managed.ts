/**
 * Read-only discovery of the unit that runs the backend the app attached to.
 *
 * The window that explains a manual update names that unit in the commands the
 * owner runs, so the app must report the real one instead of a placeholder. It
 * only reads `/proc/<pid>/cgroup`: no sudo, no `systemctl`, no signal. A process
 * the app did not start is never stopped or started by the app, and a unit that
 * was not discovered here cannot enter an instruction.
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidUnitName } from '../core/manual-update.js';

/** Marker echoed by the probe; parsed, never trusted as prose. */
export const MANAGED_MARKER = '__dsh_wsl_managed__';

/**
 * Reports which manager owns a pid and which unit started it.
 *
 * The kernel writes "0::/system.slice/x.service" (cgroup v2) or
 * "4:systemd:/system.slice/x.service" (v1), so only the text after the last colon
 * is a path. No privileged command is used: the probe must stay read-only even
 * when it runs against a unit the app could never control.
 */
export const PROBE_MANAGED_SCRIPT = [
  'set -u',
  'pid="$0"',
  'case "$pid" in ""|*[!0-9]*) echo "managed: rejected pid" >&2; exit 64 ;; esac',
  'user=$(id -un 2>/dev/null || echo unknown)',
  'path=""',
  'if [ -r "/proc/$pid/cgroup" ]; then',
  '  line=$(head -n 1 "/proc/$pid/cgroup" 2>/dev/null || true)',
  '  path="${line##*:}"',
  'fi',
  'unit="-"',
  'cand=$(printf "%s" "$path" | tr "/" "\\n" | grep -E "^[A-Za-z0-9_.@:-]+\\.service$" | tail -n 1 2>/dev/null || true)',
  'case "$cand" in ""|*[!A-Za-z0-9_.@:-]*) ;; *) unit="$cand" ;; esac',
  `printf "%s path=%s unit=%s user=%s\\n" "${MANAGED_MARKER}" "$path" "$unit" "$user"`,
  'exit 0',
].join('\n');

/** Which manager owns the attached backend. */
export interface ManagedBackend {
  /** Which systemd scope started the serving process. */
  scope: 'system' | 'user' | 'none';
  /** Unit name, or `null` when the process was not started by one. */
  unit: string | null;
  /** Linux user the backend runs as. */
  user: string;
}

export function buildProbeManagedArgs(request: { distro: string; pid: number }): string[] {
  if (!Number.isInteger(request.pid) || request.pid <= 0) throw new ArgumentError('invalid-pid');
  return ['-d', assertDistroName(request.distro), '--exec', '/bin/sh', '-c', PROBE_MANAGED_SCRIPT, String(request.pid)];
}

/**
 * Reads a single cgroup line and says which manager owns the process.
 *
 * The record is `<hierarchy>:<controllers>:<path>`; only the path matters, and it
 * is the text after the *last* colon, so both the v2 form `0::/system.slice/x`
 * and the v1 form `4:systemd:/system.slice/x` land on `/system.slice/x`.
 */
export function classifyCgroup(text: string): { scope: 'system' | 'user' | 'none'; unit: string | null } {
  const path = text.slice(text.lastIndexOf(':') + 1).trim();
  // A cgroup path is kernel-written and never contains "..", so one that does is
  // not a path this app is willing to name a unit from.
  let scope: 'system' | 'user' | 'none' = 'none';
  if (path.includes('..')) return { scope: 'none', unit: null };
  if (path.startsWith('/system.slice/')) scope = 'system';
  else if (path.startsWith('/user.slice/')) scope = 'user';
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const candidate = segments.length === 0 ? null : (segments[segments.length - 1] ?? null);
  const unit = candidate !== null && isValidUnitName(candidate) ? candidate : null;
  return { scope, unit: scope === 'none' ? null : unit };
}

export function parseManagedReport(text: string): ManagedBackend {
  const fallback: ManagedBackend = { scope: 'none', unit: null, user: 'user' };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(MANAGED_MARKER)) continue;
    const fields = new Map<string, string>();
    for (const token of line.slice(MANAGED_MARKER.length).trim().split(/\s+/)) {
      const at = token.indexOf('=');
      // A field without "=" means the reply is not the one this script writes
      // (it may carry extra words such as a user name with a space in it).
      if (at <= 0) return fallback;
      fields.set(token.slice(0, at), token.slice(at + 1));
    }
    const user = fields.get('user');
    const reportedUnit = fields.get('unit');
    if (user === undefined || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) return fallback;
    const { scope, unit: fromPath } = classifyCgroup(`0::${fields.get('path') ?? ''}`);
    if (scope === 'none' || fromPath === null) return { scope: 'none', unit: null, user };
    // The unit is taken from the path the shell reported, not from `unit=`, so a
    // backend cannot hand the caller a name that does not belong to that path.
    if (reportedUnit !== fromPath) return { scope: 'none', unit: null, user };
    return { scope, unit: fromPath, user };
  }
  return fallback;
}
