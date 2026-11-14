/**
 * The unit that runs the backend the app attached to.
 *
 * An update replaces the installation that the serving process executes, so the
 * process has to be stopped first and started again afterwards. The app never
 * signals a process it did not start, so it asks the process manager instead:
 * that is exactly what the owner would do by hand, with the same permission.
 *
 * Two scopes are possible. A user unit needs no privilege because the app runs as
 * the same user inside the distribution. A system unit needs root, which the app
 * must never hold: it uses one narrow, passwordless `sudo` rule for `systemctl
 * stop|start` of that single unit, and refuses with the exact line to add while
 * the rule is missing.
 */
import { ArgumentError, assertDistroName } from './args.js';

const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/;

/** Marker echoed by both scripts; parsed, never trusted as prose. */
export const MANAGED_MARKER = '__dsh_wsl_managed__';

/** Reports which manager owns a pid and whether the app may use it. */
export const PROBE_MANAGED_SCRIPT = [
  'set -u',
  'pid="$0"',
  'case "$pid" in ""|*[!0-9]*) echo "managed: rejected pid" >&2; exit 64 ;; esac',
  'user=$(id -un 2>/dev/null || echo unknown)',
  'scope=none; unit="-"',
  'if [ -r "/proc/$pid/cgroup" ]; then',
  'cg=$(head -n 1 "/proc/$pid/cgroup" 2>/dev/null)',
  'case "$cg" in',
  '  /system.slice/*) scope=system ;;',
  '  /user.slice/*) scope=user ;;',
  'esac',
  'cand=$(printf "%s" "$cg" | tr "/" "\\n" | grep -E "\\.service$" | tail -n 1 2>/dev/null)',
  'case "$cand" in ""|*[!A-Za-z0-9_.@:-]*) ;; *) if [ "$scope" != none ]; then unit="$cand"; fi ;; esac',
  'fi',
  'can=0',
  'if [ "$scope" = system ]; then',
  '  sudo -n -l "/usr/bin/systemctl stop $unit" >/dev/null 2>&1 && can=1',
  'elif [ "$scope" = user ]; then',
  '  systemctl --user show "$unit" --property=Id >/dev/null 2>&1 && can=1',
  'fi',
  `printf "%s scope=%s unit=%s can=%s user=%s\\n" "${MANAGED_MARKER}" "$scope" "$unit" "$can" "$user"`,
  'exit 0',
].join('\n');

/** Stops or starts one unit the probe reported as controllable. */
export const CONTROL_MANAGED_SCRIPT = [
  'set -u',
  'scope="$0"; unit="$1"; action="$2"',
  'case "$action" in stop|start) ;; *) echo "managed: rejected action" >&2; exit 64 ;; esac',
  'case "$unit" in ""|*[!A-Za-z0-9_.@:-]*) echo "managed: rejected unit" >&2; exit 64 ;; esac',
  'case "$scope" in',
  '  system) sudo -n /usr/bin/systemctl "$action" "$unit" ;;',
  '  user) systemctl --user "$action" "$unit" ;;',
  '  *) echo "managed: rejected scope" >&2; exit 64 ;;',
  'esac',
  'rc=$?',
  'if [ "$rc" -ne 0 ]; then',
  '  case "$rc" in 1) echo "managed: systemctl $action $unit was refused (missing sudo rule for this unit, or the unit does not exist)" ;; *) echo "managed: systemctl $action $unit failed (rc=$rc)" ;; esac',
  '  exit "$rc"',
  'fi',
  `printf "%s action=%s unit=%s ok=1\\n" "${MANAGED_MARKER}" "$action" "$unit"`,
  'exit 0',
].join('\n');

export interface ManagedBackend {
  /** Which manager owns the serving process. */
  scope: 'system' | 'user' | 'none';
  /** Unit name, or `null` when the process was not started by one. */
  unit: string | null;
  /** True when the app may stop and start that unit without a password. */
  canControl: boolean;
  /** Linux user the backend runs as; named in the sudoers hint. */
  user: string;
}

export function assertUnitName(unit: string): string {
  if (typeof unit !== 'string' || !UNIT_PATTERN.test(unit)) throw new ArgumentError('invalid-unit-name');
  return unit;
}

export function buildProbeManagedArgs(request: { distro: string; pid: number }): string[] {
  if (!Number.isInteger(request.pid) || request.pid <= 0) throw new ArgumentError('invalid-pid');
  return ['-d', assertDistroName(request.distro), '--exec', '/bin/sh', '-c', PROBE_MANAGED_SCRIPT, String(request.pid)];
}

export function buildControlManagedArgs(request: {
  distro: string;
  scope: 'system' | 'user';
  unit: string;
  action: 'stop' | 'start';
}): string[] {
  if (request.scope !== 'system' && request.scope !== 'user') throw new ArgumentError('invalid-scope');
  if (request.action !== 'stop' && request.action !== 'start') throw new ArgumentError('invalid-action');
  return [
    '-d',
    assertDistroName(request.distro),
    '--exec',
    '/bin/sh',
    '-c',
    CONTROL_MANAGED_SCRIPT,
    request.scope,
    assertUnitName(request.unit),
    request.action,
  ];
}

/** Parse the probe report; unrecognised output means "no manager". */
export function parseManagedReport(text: string): ManagedBackend {
  const empty: ManagedBackend = { scope: 'none', unit: null, canControl: false, user: 'user' };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith(`${MANAGED_MARKER} `)) continue;
    const fields = new Map<string, string>();
    for (const part of line.slice(MANAGED_MARKER.length + 1).split(' ')) {
      const at = part.indexOf('=');
      if (at > 0) fields.set(part.slice(0, at), part.slice(at + 1));
    }
    const scope = fields.get('scope');
    const rawUser = fields.get('user') ?? '';
    const user = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(rawUser) ? rawUser : 'user';
    if (scope === 'none') return { scope: 'none', unit: null, canControl: false, user };
    if (scope !== 'system' && scope !== 'user') return empty;
    const unit = fields.get('unit') ?? '';
    if (!UNIT_PATTERN.test(unit)) return empty;
    return { scope, unit, canControl: fields.get('can') === '1', user };
  }
  return empty;
}

/** The one narrow rule the app needs for a system unit; shown to the owner. */
export function sudoersLines(request: { user: string; unit: string }): string[] {
  const user = /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(request.user) ? request.user : '<your WSL user>';
  const unit = assertUnitName(request.unit);
  return [
    `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${unit}, /usr/bin/systemctl start ${unit}`,
  ];
}

/**
 * Installs the one sudo rule that lets the app stop and start a system unit.
 *
 * The password is asked once, inside the app, and only travels over the stdin
 * pipe of the WSL command: never in an argument list (every process on the
 * machine can read those), never in a log line, never written to disk. `sudo -S`
 * reads the first line; the root script then writes the drop-in, checks it with
 * `visudo -c` and removes it again when the syntax is rejected, so a mistake can
 * never leave a broken sudoers file behind.
 */
export const INSTALL_RULE_SCRIPT = [
  'set -u',
  'IFS= read -r dsh_pass || { echo "rule: no password on stdin" >&2; exit 64; }',
  'if [ -z "$dsh_pass" ]; then echo "rule: empty password" >&2; exit 64; fi',
  // $0 carries the already validated root script; the password stays on stdin.
  'printf "%s\\n" "$dsh_pass" | sudo -S -p "" /bin/sh -c "$0"',
  'rc=$?',
  'dsh_pass=""',
  'exit "$rc"',
].join('\n');

/** The root half: writes the drop-in, validates it, and reports one marker line. */
export function buildRootRuleScript(request: { user: string; unit: string }): string {
  const user = assertUserName(request.user);
  const unit = assertUnitName(request.unit);
  const rule = `${user} ALL=(root) NOPASSWD: /usr/bin/systemctl stop ${unit}, /usr/bin/systemctl start ${unit}`;
  return [
    'set -eu',
    `printf '%s\\n' '${rule}' > /etc/sudoers.d/dsh-update`,
    'chmod 0440 /etc/sudoers.d/dsh-update',
    'if ! { visudo -c || /usr/sbin/visudo -c; } >/dev/null 2>&1; then',
    '  rm -f /etc/sudoers.d/dsh-update',
    '  echo "rule: the sudoers syntax check failed, the file was removed" >&2',
    '  exit 2',
    'fi',
    `printf '%s\\n' "${MANAGED_MARKER} ok=1 unit=${unit}"`,
    'exit 0',
  ].join('\n');
}

export function assertUserName(user: string): string {
  if (typeof user !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user)) {
    throw new ArgumentError('invalid-user-name');
  }
  return user;
}

export function buildInstallRuleArgs(request: { distro: string; user: string; unit: string }): string[] {
  const root = buildRootRuleScript({ user: request.user, unit: request.unit });
  return ['-d', assertDistroName(request.distro), '--exec', '/bin/sh', '-c', INSTALL_RULE_SCRIPT, root];
}

export function parseInstallRuleReport(text: string): { ok: boolean; message: string | null } {
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim().startsWith(`${MANAGED_MARKER} ok=1`)) return { ok: true, message: null };
  }
  const detail = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .slice(0, 300);
  return { ok: false, message: detail === '' ? null : detail };
}
