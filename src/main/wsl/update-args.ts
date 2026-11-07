/**
 * WSL commands for the one-click update (issue #12).
 *
 * Two read-only-then-write steps, both executed with `wsl.exe --exec /bin/sh -c`
 * so no shell quoting of user data is ever needed: every value arrives as a
 * positional argument and is validated before it is used.
 *
 * 1. `NPM_VIEW_SCRIPT` asks npm whether the exact version exists. Read-only.
 * 2. `UPDATE_SCRIPT` installs that version into a staging prefix **inside the
 *    isolated root**, verifies it, swaps it into `runtime/` and keeps the old
 *    tree as `update/previous-<timestamp>` for rollback.
 *
 * The scripts never install a distribution package, never touch the user's
 * global prefix and never remove anything outside `<root>/update`.
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidIsolationRoot, isValidRuntimeBinary, joinPosix } from '../core/isolation.js';
import { isExactVersion } from '../core/update.js';

export const NPM_PACKAGE = '@deepseek-ai/dsh' as const;

/** Marker printed by the scripts right before the resolved npm path. */
export const NPM_MARKER = '__wsl_web_shell_npm__';

/**
 * Shared npm lookup: the isolated runtime prefix first, then the usual places.
 * Nothing is installed or created by the lookup itself.
 */
const NPM_LOOKUP = [
  `npm_bin=""`,
  `for c in "$root/runtime/bin/npm" "$HOME/.local/bin/npm" /usr/local/bin/npm /usr/bin/npm /bin/npm; do`,
  `if [ -x "$c" ]; then npm_bin="$c"; break; fi`,
  `done`,
  `if [ -z "$npm_bin" ] && command -v npm >/dev/null 2>&1; then npm_bin="$(command -v npm)"; fi`,
  `printf "%s %s\\n" "${NPM_MARKER}" "$npm_bin"`,
].join('\n');

/**
 * Ask npm for the exact version. Read-only: `npm view` only queries the
 * registry that the distribution's npm configuration points at.
 *
 * `$0` = isolation root, `$1` = version, `$2` = node binary (or `-`).
 */
export const NPM_VIEW_SCRIPT = [
  'set -eu',
  'root="$0"; ver="$1"; node="$2"',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  '[ -d "$root/runtime" ] || { echo "wsl-web-shell: the isolated runtime is missing" >&2; exit 68; }',
  NPM_LOOKUP,
  '[ -n "$npm_bin" ] || { echo "wsl-web-shell: npm was not found in this distribution" >&2; exit 69; }',
  `"$npm_bin" view "${NPM_PACKAGE}@$ver" version --json 2>&1`,
].join('\n');

/**
 * Install an exact version into a staging prefix, verify it, then swap it in.
 *
 * Exit codes: 68 missing root/runtime, 69 missing npm, 70 install produced no
 * executable, 71 staged verification failed, 72 activation verification failed
 * (previous install restored), 73 activation failed (previous install restored).
 * Any failure before the swap leaves `runtime/` untouched.
 *
 * `$0` = isolation root, `$1` = version, `$2` = npm binary, `$3` = node (or `-`).
 */
export const UPDATE_SCRIPT = [
  'set -eu',
  'root="$0"; ver="$1"; npm_bin="$2"; node="$3"',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  'rt="$root/runtime"; upd="$root/update"',
  'ts="$(date -u +%Y%m%dT%H%M%SZ)"',
  'stage="$upd/stage-$ts"; prev="$upd/previous-$ts"',
  '[ -d "$root" ] || { echo "update: the isolated root is missing" >&2; exit 68; }',
  '[ -d "$rt" ] || { echo "update: the isolated runtime is missing" >&2; exit 68; }',
  '[ -n "$npm_bin" ] && [ -x "$npm_bin" ] || { echo "update: npm was not found in this distribution" >&2; exit 69; }',
  'mkdir -p "$upd"',
  'echo "update: package ' + NPM_PACKAGE + '@$ver"',
  'echo "update: staging prefix $stage"',
  'echo "update: npm $npm_bin"',
  'rm -rf "$stage"',
  'status=0',
  // Cache and prefixes stay inside the isolated root: the user's npm cache and
  // global prefix are never written to.
  `"$npm_bin" install --global --prefix "$stage" --cache "$root/cache/npm" --no-audit --no-fund --loglevel=warn "${NPM_PACKAGE}@$ver" || status=$?`,
  'if [ "$status" -ne 0 ]; then echo "update: install failed with exit code $status" >&2; rm -rf "$stage"; exit "$status"; fi',
  '[ -x "$stage/bin/dsh" ] || { echo "update: the staged install has no dsh executable" >&2; rm -rf "$stage"; exit 70; }',
  'echo "update: verifying the staged installation"',
  'staged=""',
  'staged="$("$stage/bin/dsh" --version 2>&1)" || staged=""',
  'case "$staged" in *"$ver"*) ;; *) echo "update: staged version check failed: $staged" >&2; rm -rf "$stage"; exit 71;; esac',
  'echo "update: staged version $staged"',
  'echo "update: activating"',
  'rm -rf "$prev"',
  'mv "$rt" "$prev"',
  'mv "$stage" "$rt" || { echo "update: activation failed, restoring the previous install" >&2; mv "$prev" "$rt"; exit 73; }',
  'active=""',
  'active="$("$rt/bin/dsh" --version 2>&1)" || active=""',
  'case "$active" in *"$ver"*) ;; *)',
  'echo "update: activated version check failed: $active" >&2',
  'echo "update: restoring the previous install" >&2',
  'rm -rf "$rt"; mv "$prev" "$rt"; exit 72;;',
  'esac',
  'echo "update: installed version $active"',
  'echo "update: previous installation kept at $prev"',
  // Keep exactly one rollback copy: the one just created.
  'for old in $(ls -1d "$upd"/previous-* 2>/dev/null | sort -r | sed -e "1d"); do rm -rf "$old"; done',
  'echo "update: done"',
].join('\n');

export interface UpdateScriptRequest {
  distro: string;
  isolationRoot: string;
  version: string;
  nodePath: string | null;
}

function assertRequest(request: UpdateScriptRequest): { root: string; version: string; node: string } {
  const distro = assertDistroName(request.distro);
  if (!isValidIsolationRoot(request.isolationRoot)) throw new ArgumentError('invalid-isolation-root');
  if (!isExactVersion(request.version)) throw new ArgumentError('invalid-version');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  void distro;
  return {
    root: request.isolationRoot,
    version: request.version,
    node: request.nodePath ?? '-',
  };
}

/** Read-only existence check of one exact published version. */
export function buildNpmViewArgs(request: UpdateScriptRequest): string[] {
  const { root, version, node } = assertRequest(request);
  return ['-d', assertDistroName(request.distro), '--exec', '/bin/sh', '-c', NPM_VIEW_SCRIPT, root, version, node];
}

/** Install exactly `version` into the isolated runtime (with rollback). */
export function buildInstallRuntimeArgs(request: UpdateScriptRequest, npmPath: string): string[] {
  const { root, version, node } = assertRequest(request);
  if (!isValidRuntimeBinary(npmPath)) throw new ArgumentError('invalid-runtime-binary');
  return ['-d', assertDistroName(request.distro), '--exec', '/bin/sh', '-c', UPDATE_SCRIPT, root, version, npmPath, node];
}

/** Where the rollback copy lives for a given root (documentation/UI hint). */
export function describePreviousInstall(root: string): string {
  return joinPosix(root, 'update', 'previous-<timestamp>');
}

const NPM_LINE = new RegExp(`^${NPM_MARKER} (.+)$`);

/** Parse the npm path announced by the scripts. */
export function parseNpmMarker(line: string): string | null {
  const match = NPM_LINE.exec(line.trim());
  if (match === null) return null;
  const path = match[1]?.trim() ?? '';
  return isValidRuntimeBinary(path) ? path : null;
}
