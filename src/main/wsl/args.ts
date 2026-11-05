/**
 * `wsl.exe` invocation builders.
 *
 * Every argument is a fixed literal or a validated value placed in its own
 * array slot: nothing is concatenated into a shell string. Linux-side script
 * text is a module constant; per-launch values arrive as positional parameters.
 */
import { LOOPBACK_HOST } from '../../shared/types.js';

export const WSL_EXE = 'wsl.exe';

/**
 * Prints the Linux PID that will own the web server, then replaces itself with
 * the server process (same PID), so the PID we record stays valid.
 * `$0` = resolved dsh path, `$1` = host, `$2` = port.
 */
export const START_WRAPPER_SCRIPT = [
  'printf "%s %s\\n" "__dsh_web_shell_pid__" "$$";',
  'exec "$0" web --host "$1" --port "$2" --no-open',
].join(' ');

export const PID_MARKER = '__dsh_web_shell_pid__';

/**
 * Locate the `dsh` executable inside the distribution. Diagnostics only:
 * read-only filesystem tests, no package installation.
 */
export const RESOLVE_DSH_SCRIPT = [
  'for c in "$HOME/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh "$HOME/.npm-global/bin/dsh"; do',
  'if [ -x "$c" ]; then printf "%s\\n" "$c"; exit 0; fi; done;',
  'for c in "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/.volta/bin/dsh; do',
  'if [ -x "$c" ]; then printf "%s\\n" "$c"; exit 0; fi; done;',
  'p=$(command -v dsh 2>/dev/null) && [ -x "$p" ] && { printf "%s\\n" "$p"; exit 0; };',
  'p=$(bash -lc "command -v dsh" 2>/dev/null | tail -n 1) && [ -x "$p" ] && { printf "%s\\n" "$p"; exit 0; };',
  'exit 3',
].join(' ');

/**
 * Read start time and command line of a Linux PID. The start time guards
 * against PID reuse; the command line proves the process is our backend.
 */
export const PROBE_PROCESS_SCRIPT = [
  'pid="$1";',
  '[ -r "/proc/$pid/stat" ] || exit 10;',
  '[ -r "/proc/$pid/cmdline" ] || exit 11;',
  'read -r st < "/proc/$pid/stat" || exit 12;',
  'rest=${st##*) };',
  'set -- $rest;',
  '[ $# -ge 20 ] || exit 13;',
  'shift 19;',
  'printf "starttime=%s\\n" "$1";',
  'printf "cmdline="; tr "\\000" " " < "/proc/$pid/cmdline"; printf "\\n"',
].join(' ');

const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const POSIX_PATH_PATTERN = /^(?:~|\/)[^\0\r\n]*$/;

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}

export function assertDistroName(distro: string): string {
  if (typeof distro !== 'string' || !DISTRO_PATTERN.test(distro)) {
    throw new ArgumentError('invalid-wsl-distro-name');
  }
  return distro;
}

export function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new ArgumentError('invalid-port');
  }
  return port;
}

export function assertWorkspace(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length > 4096 || !POSIX_PATH_PATTERN.test(workspace)) {
    throw new ArgumentError('invalid-workspace-path');
  }
  if (workspace.includes('\\')) throw new ArgumentError('invalid-workspace-path');
  return workspace;
}

export function assertDshPath(dshPath: string): string {
  if (typeof dshPath !== 'string' || !dshPath.startsWith('/') || dshPath.length > 4096) {
    throw new ArgumentError('invalid-dsh-path');
  }
  if (/[\0\r\n]/.test(dshPath) || dshPath.split('/').includes('..')) {
    throw new ArgumentError('invalid-dsh-path');
  }
  return dshPath;
}

export function assertLinuxPid(pid: number): number {
  if (!Number.isInteger(pid) || pid <= 1 || pid > 4_194_304) {
    throw new ArgumentError('invalid-linux-pid');
  }
  return pid;
}

/** `wsl.exe -l -q` — installed distribution names. */
export function buildListDistrosArgs(): string[] {
  return ['-l', '-q'];
}

/** Resolve the backend executable; prints its absolute path on success. */
export function buildResolveDshArgs(distro: string): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/sh', '-c', RESOLVE_DSH_SCRIPT];
}

/** Verify a user-supplied absolute executable path without running it. */
export function buildDshPathCheckArgs(distro: string, dshPath: string): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/test', '-x', assertDshPath(dshPath)];
}

export interface StartServerOptions {
  distro: string;
  dshPath: string;
  port: number;
  workspace: string;
  host?: string;
}

/**
 * Launch `dsh web` inside the distribution.
 * `--exec` avoids a shell for the outer command; the inner `bash -c` receives
 * only fixed script text plus validated positional values.
 */
export function buildStartServerArgs(options: StartServerOptions): string[] {
  const host = options.host ?? LOOPBACK_HOST;
  if (host !== LOOPBACK_HOST) throw new ArgumentError('invalid-bind-host');
  return [
    '-d',
    assertDistroName(options.distro),
    '--cd',
    assertWorkspace(options.workspace),
    '--exec',
    '/bin/bash',
    '-c',
    START_WRAPPER_SCRIPT,
    assertDshPath(options.dshPath),
    host,
    String(assertPort(options.port)),
  ];
}

export function buildProbeProcessArgs(distro: string, pid: number): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/sh', '-c', PROBE_PROCESS_SCRIPT, String(assertLinuxPid(pid))];
}

/** POSIX signal delivery by number-free name to one verified PID. */
export function buildSignalArgs(distro: string, pid: number, signal: 'TERM' | 'KILL'): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/sh', '-c', `kill -s ${signal} "$1" 2>/dev/null || exit 1`, String(assertLinuxPid(pid))];
}

export function buildDistroProbeArgs(distro: string): string[] {
  return ['-d', assertDistroName(distro), '--exec', '/bin/true'];
}

export function buildWslVersionArgs(): string[] {
  return ['--version'];
}

export function buildWslStatusArgs(): string[] {
  return ['--status'];
}
