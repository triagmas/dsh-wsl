/**
 * WSL commands for the DeepSeek Harness update (issue #17).
 *
 * DSH WSL updates the **installation it runs**: the `dsh` the user's WSL shell
 * also runs. Nothing is installed into an app-private prefix any more. Every
 * step runs as `wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>`, so no
 * user value is interpolated into shell text: each one arrives as a positional
 * parameter, is validated in TypeScript and is validated again in the script
 * before it is used.
 *
 * Steps:
 * 1. `NPM_VIEW_SCRIPT` — read-only: does that exact version exist on npm?
 * 2. `INSPECT_SHARED_SCRIPT` — read-only: path, realpath, version, install
 *    manager, npm prefix, writability and foreign processes of the installation.
 * 3. `UPDATE_SHARED_SCRIPT` — `npm install -g` into the reported prefix after a
 *    preflight re-check, a best-effort backup copy, then verify the executable.
 *    A failed install is rolled back by reinstalling the previous exact version.
 * 4. `ROLLBACK_SHARED_SCRIPT` — reinstall the previous exact version (failure
 *    path and journal recovery after an interrupted update).
 *
 * Shared rules enforced by every script:
 * - versions, prefixes and transaction ids are validated character by character;
 * - `npm prefix -g` must agree with the prefix the caller reported, so an
 *   environment override cannot redirect the install;
 * - the prefix must be writable without sudo/UAC — otherwise the app fails
 *   closed instead of escalating;
 * - nothing is written through a symlinked directory, and no `dsh` process that
 *   the app does not own is signalled (the update never kills anything).
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidRuntimeBinary } from '../core/isolation.js';
import { isExactVersion, isValidTransactionId } from '../core/update.js';
import { INSPECT_MARKER } from '../core/dsh-locate.js';

export const NPM_PACKAGE = '@deepseek-ai/dsh' as const;

/** Marker printed by the npm view script right before the resolved npm path. */
export const NPM_MARKER = '__wsl_web_shell_npm__';

/** Absolute POSIX path with the strict charset used everywhere else. */
const SAFE_PATH = /^\/[A-Za-z0-9._~/@+-]*$/;

function assertAbsolutePath(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.split('/').includes('..')) {
    throw new ArgumentError('invalid-absolute-path');
  }
  return value;
}

/** `dsh --version` reader with an exact-comparison result. */
const VERSION_HELPER = [
  'version_of() {',
  'out="$("$1" --version 2>/dev/null | tr -d "\\r" | head -n 1)" || out=""',
  'out="$(printf "%s" "$out" | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]]*$//")"',
  'case "$out" in dsh[[:space:]]*) out="${out#dsh}" ;; esac',
  'out="$(printf "%s" "$out" | awk "{print \\$1}")"',
  'out="${out#v}"',
  'printf "%s" "$out"',
  '}',
].join('\n');

/**
 * Count processes that run from the installation we are about to change.
 *
 * Foreign processes are never killed and never ignored silently: the caller
 * refuses the update and explains that the other DSH session has to be closed
 * first. `$1` = real path of the executable, `$2` = PID the app owns (`-` when
 * nothing is running). The scan excludes itself.
 */
const FOREIGN_HELPER = [
  'foreign_count() {',
  'target="$1"; own="$2"; n=0',
  'for d in /proc/[0-9]*; do',
  'pid="${d#/proc/}"',
  '[ "$pid" = "$$" ] && continue',
  '[ "$own" != "-" ] && [ "$pid" = "$own" ] && continue',
  '[ -r "$d/cmdline" ] || continue',
  'cmd="$(tr "\\000" " " < "$d/cmdline" 2>/dev/null || true)"',
  'case "$cmd" in *"$target"*) n=$((n+1)) ;; esac',
  'done',
  'printf "%s" "$n"',
  '}',
].join('\n');

/** npm lookup order for the distribution's own npm (no private copy). */
const NPM_LOOKUP = [
  'npm_bin=""',
  'for c in "$HOME/.local/bin/npm" /usr/local/bin/npm /usr/bin/npm /bin/npm; do',
  'if [ -x "$c" ]; then npm_bin="$c"; break; fi',
  'done',
  'if [ -z "$npm_bin" ] && command -v npm >/dev/null 2>&1; then npm_bin="$(command -v npm)"; fi',
].join('\n');

/** Shared npm environment for the update: private cache, no prompts, no metadata. */
const NPM_ENV = [
  'export npm_config_update_notifier=false',
  'export npm_config_fund=false',
  'export npm_config_audit=false',
  'export npm_config_progress=false',
].join('\n');

/**
 * Ask npm for the exact version. Read-only.
 *
 * The npm cache is the app's own directory (inside the isolated root, or a
 * user-cache fallback), so an update never writes into `~/.npm` metadata of the
 * user's own global installs.
 *
 * `$0` = app data root (`-` when isolation is off), `$1` = version,
 * `$2` = node (or `-`).
 */
export const NPM_VIEW_SCRIPT = [
  'set -u',
  'root="$0"; ver="$1"; node="$2"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  'if [ "$root" = "-" ]; then cache="$HOME/.cache/wsl-web-shell/npm"; else ' +
    'case "$root" in "~/"*) root="$HOME/${root#"~/"}" ;; esac; cache="$root/cache/npm"; fi',
  NPM_LOOKUP,
  '[ -n "$npm_bin" ] || { echo "update: npm was not found in this distribution" >&2; exit 69; }',
  'mkdir -p "$cache" 2>/dev/null || true',
  NPM_ENV,
  'export npm_config_cache="$cache"',
  'printf "%s %s\\n" "' + NPM_MARKER + '" "$npm_bin"',
  `"$npm_bin" view "${NPM_PACKAGE}@$ver" version --json --cache "$cache" 2>&1`,
].join('\n');

/**
 * Read-only provenance report of the installation the launcher uses.
 *
 * Reports `found`, `path`, `real`, `link`, `version`, `manager`, `prefix`,
 * `package`, `writable`, `npm`, `foreign` and `legacy` (an older private runtime
 * still exists on disk; it is reported but not selected).
 *
 * Exit codes: 64 malformed argument.
 *
 * `$0` = executable (`-` to resolve it here), `$1` = app data root (`-`),
 * `$2` = node (or `-`), `$3` = app-owned PID to exclude (`-`).
 */
export const INSPECT_SHARED_SCRIPT = [
  'set -u',
  'want="$0"; app_root="$1"; node="$2"; own="$3"',
  'case "$want" in "-"|/*) ;; *) echo "update: rejected executable path" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  VERSION_HELPER,
  FOREIGN_HELPER,
  'root=""; legacy=no',
  'if [ "$app_root" != "-" ]; then',
  'case "$app_root" in "~/"*) root="$HOME/${app_root#"~/"}" ;; /*) root="$app_root" ;; esac',
  'if [ -d "$root" ]; then root="$(cd "$root" && pwd -P)" || root=""; fi',
  '[ -n "$root" ] && [ -x "$root/runtime/bin/dsh" ] && legacy=yes',
  'fi',
  `printf "%s legacy=%s\\n" "${INSPECT_MARKER}" "$legacy"`,
  'dsh="$want"; source="custom"',
  'if [ "$dsh" = "-" ]; then',
  'source=""',
  'if command -v bash >/dev/null 2>&1; then p=$(bash -lc "command -v dsh" 2>/dev/null | tr -d "\\r" | tail -n 1); [ -n "$p" ] && [ -x "$p" ] && { dsh="$p"; source="login-shell"; }; fi',
  'if [ -z "$source" ]; then p=$(command -v dsh 2>/dev/null); [ -n "$p" ] && [ -x "$p" ] && { dsh="$p"; source="path"; }; fi',
  'if [ -z "$source" ]; then for c in "$HOME/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh "$HOME/.npm-global/bin/dsh" "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/.volta/bin/dsh; do',
  '[ -x "$c" ] && { dsh="$c"; source="fallback"; break; }; done; fi',
  'fi',
  'if [ -z "$dsh" ] || [ ! -x "$dsh" ]; then',
  `printf "%s found=no\\n" "${INSPECT_MARKER}"`,
  'exit 0',
  'fi',
  'real="$(readlink -f "$dsh" 2>/dev/null)" || real=""',
  '[ -n "$real" ] || real="$dsh"',
  'link=no; [ -L "$dsh" ] && link=yes',
  'for c in "$HOME/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh; do [ "$c" = "$dsh" ] && alias=yes; done',
  'ver="$(version_of "$dsh")"',
  `printf "%s found=yes\\n" "${INSPECT_MARKER}"`,
  `printf "%s path=%s\\n" "${INSPECT_MARKER}" "$dsh"`,
  `printf "%s real=%s\\n" "${INSPECT_MARKER}" "$real"`,
  `printf "%s link=%s\\n" "${INSPECT_MARKER}" "$link"`,
  `printf "%s source=%s\\n" "${INSPECT_MARKER}" "$source"`,
  `printf "%s version=%s\\n" "${INSPECT_MARKER}" "$ver"`,
  NPM_LOOKUP,
  '[ -n "$npm_bin" ] || npm_bin="-"',
  `printf "%s npm=%s\\n" "${INSPECT_MARKER}" "$npm_bin"`,
  'prefix=""; pkg=""; manager="unknown"',
  'if [ "$npm_bin" != "-" ]; then',
  'p="$("$npm_bin" prefix -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'case "$p" in /*) prefix="$p" ;; esac',
  'fi',
  'if [ -n "$prefix" ]; then',
  'for layout in lib/node_modules node_modules; do',
  'cand="$prefix/$layout/' + NPM_PACKAGE + '"',
  'if [ -d "$cand" ]; then',
  'creal="$(cd "$cand" && pwd -P 2>/dev/null)" || creal="$cand"',
  'case "$real" in "$creal"/*) manager="npm"; pkg="$creal"; break ;; esac',
  'fi',
  'done',
  'fi',
  'if [ "$manager" = "unknown" ] && command -v pnpm >/dev/null 2>&1; then',
  'proot="$(pnpm root -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'case "$proot" in /*) case "$real" in "$proot"/*) manager="pnpm"; prefix="$proot"; pkg="$proot" ;; esac ;; esac',
  'fi',
  'writable=no',
  'if [ "$manager" = "npm" ] && [ -n "$prefix" ]; then',
  'if [ -w "$prefix" ] && { [ ! -d "$prefix/lib/node_modules" ] || [ -w "$prefix/lib/node_modules" ]; }; then writable=yes; fi',
  'fi',
  '[ -n "$prefix" ] || prefix="-"',
  '[ -n "$pkg" ] || pkg="-"',
  `printf "%s manager=%s\\n" "${INSPECT_MARKER}" "$manager"`,
  `printf "%s prefix=%s\\n" "${INSPECT_MARKER}" "$prefix"`,
  `printf "%s package=%s\\n" "${INSPECT_MARKER}" "$pkg"`,
  `printf "%s writable=%s\\n" "${INSPECT_MARKER}" "$writable"`,
  `printf "%s foreign=%s\\n" "${INSPECT_MARKER}" "$(foreign_count "$real" "$own")"`,
  'exit 0',
].join('\n');

/**
 * Install the exact target version into the prefix the installation already uses.
 *
 * The prefix, package directory and executable are re-checked here, so a plan
 * built a moment earlier cannot be redirected by a changed environment. The
 * previous package is copied into the app's own data root first (best effort);
 * the authoritative recovery path is reinstalling the previous exact version.
 *
 * Exit codes: 64 bad argument, 69 no npm, 71 the installation does not report the
 * expected current version, 72 install failed and the previous version was
 * restored, 73 install failed and the restore failed, 74 the new version does not
 * report the target version (restore attempted), 75 the prefix is not writable,
 * 76 npm reports a different prefix, 77 the installation is already at the
 * target version, 78 another DSH process uses this installation.
 *
 * `$0` = prefix, `$1` = target version, `$2` = installed version, `$3` = npm,
 * `$4` = node (or `-`), `$5` = transaction id, `$6` = executable,
 * `$7` = package directory, `$8` = app data root (`-`), `$9` = app-owned PID (`-`).
 */
export const UPDATE_SHARED_SCRIPT = [
  'set -u',
  'prefix="$0"; ver="$1"; installed="$2"; npm_bin="$3"; node="$4"; tx="$5"; dsh="$6"; pkg="$7"; app_root="$8"; own="$9"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$installed" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected installed version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'case "$prefix" in /*) ;; *) echo "update: rejected npm prefix" >&2; exit 64 ;; esac',
  'case "$dsh" in /*) ;; *) echo "update: rejected executable path" >&2; exit 64 ;; esac',
  'case "$pkg" in /*|-) ;; *) echo "update: rejected package path" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  VERSION_HELPER,
  FOREIGN_HELPER,
  'if [ -z "$npm_bin" ] || [ "$npm_bin" = "-" ] || [ ! -x "$npm_bin" ]; then echo "update: npm was not found in this distribution" >&2; exit 69; fi',
  'reported="$("$npm_bin" prefix -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ "$reported" != "$prefix" ]; then echo "update: npm reports prefix [$reported] instead of [$prefix]" >&2; exit 76; fi',
  'if [ ! -w "$prefix" ]; then echo "update: the npm prefix $prefix is not writable without elevated rights" >&2; exit 75; fi',
  'if [ -d "$prefix/lib/node_modules" ] && [ ! -w "$prefix/lib/node_modules" ]; then echo "update: $prefix/lib/node_modules is not writable without elevated rights" >&2; exit 75; fi',
  'now="$(version_of "$dsh")"',
  'if [ "$now" = "$ver" ]; then echo "update: the installation already reports $ver" >&2; exit 77; fi',
  'if [ "$now" != "$installed" ]; then echo "update: the installation reports [$now], expected [$installed]" >&2; exit 71; fi',
  'real="$(readlink -f "$dsh" 2>/dev/null)" || real="$dsh"',
  'foreign="$(foreign_count "$real" "$own")"',
  'if [ "$foreign" != "0" ]; then echo "update: $foreign other DeepSeek Harness process(es) use $dsh" >&2; exit 78; fi',
  'if [ "$app_root" = "-" ]; then base="$HOME/.cache/wsl-web-shell"; else',
  'case "$app_root" in "~/"*) base="$HOME/${app_root#"~/"}" ;; /*) base="$app_root" ;; esac',
  '[ -d "$base" ] && base="$(cd "$base" && pwd -P)"',
  'fi',
  'cache="$base/cache/npm"',
  'mkdir -p "$cache" 2>/dev/null || true',
  'backup=""',
  'if [ -n "$base" ] && [ -d "$pkg" ]; then',
  'backup="$base/update/shared-backup-$tx"',
  'mkdir -p "$base/update" 2>/dev/null || true',
  'if rm -rf "$backup" && cp -a "$pkg" "$backup" 2>/dev/null; then echo "update: previous package copied to $backup"; else backup=""; fi',
  'fi',
  NPM_ENV,
  'export npm_config_cache="$cache"',
  // Restore: npm reinstall of the exact previous version, then the local copy.
  'restore() {',
  'echo "update: reinstalling ' + NPM_PACKAGE + '@$installed" >&2',
  'if "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$installed" >/dev/null 2>&1; then',
  'if [ "$(version_of "$dsh")" = "$installed" ]; then return 0; fi',
  'fi',
  'if [ -n "$backup" ] && [ -d "$backup" ] && [ "$pkg" != "-" ]; then',
  'echo "update: restoring the previous package from $backup" >&2',
  'rm -rf "$pkg" && cp -a "$backup" "$pkg" || return 1',
  'if [ "$(version_of "$dsh")" = "$installed" ]; then return 0; fi',
  'fi',
  'return 1',
  '}',
  'echo "update: installing ' + NPM_PACKAGE + '@$ver into $prefix"',
  'echo "update: npm $npm_bin"',
  'if ! "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$ver"; then',
  'echo "update: npm install failed" >&2',
  'if restore; then echo "update: previous version restored"; exit 72; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  'echo "update: verifying $dsh"',
  'new="$(version_of "$dsh")"',
  'if [ "$new" != "$ver" ]; then',
  'echo "update: the installation reports [$new] instead of [$ver]" >&2',
  'if restore; then echo "update: previous version restored"; exit 74; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  'if command -v bash >/dev/null 2>&1; then',
  'login="$(bash -lc "command -v dsh" 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ -n "$login" ]; then',
  'login_real="$(readlink -f "$login" 2>/dev/null)" || login_real="$login"',
  'if [ "$login_real" = "$(readlink -f "$dsh" 2>/dev/null)" ]; then',
  'echo "update: a login shell resolves the updated executable"',
  'else',
  'echo "update: warning: a login shell resolves $login instead of $dsh" >&2',
  'fi',
  'fi',
  'fi',
  'if [ -n "$backup" ] && [ -d "$backup" ]; then echo "update: previous package kept at $backup"; fi',
  'exit 0',
].join('\n');

/**
 * Reinstall the previous exact version (failure path and journal recovery).
 *
 * Exit codes: 64 bad argument, 69 no npm, 75 not writable, 76 npm prefix
 * disagreement, 74 the previous version could not be restored.
 *
 * `$0` = prefix, `$1` = version to restore, `$2` = npm, `$3` = node (or `-`),
 * `$4` = executable, `$5` = package directory (`-` when unknown),
 * `$6` = transaction id, `$7` = app data root (`-`).
 */
export const ROLLBACK_SHARED_SCRIPT = [
  'set -u',
  'prefix="$0"; ver="$1"; npm_bin="$2"; node="$3"; dsh="$4"; pkg="$5"; tx="$6"; app_root="$7"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$prefix" in /*) ;; *) echo "update: rejected npm prefix" >&2; exit 64 ;; esac',
  'case "$dsh" in /*) ;; *) echo "update: rejected executable path" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  VERSION_HELPER,
  'if [ -z "$npm_bin" ] || [ "$npm_bin" = "-" ] || [ ! -x "$npm_bin" ]; then echo "update: npm was not found in this distribution" >&2; exit 69; fi',
  'if [ ! -w "$prefix" ]; then echo "update: the npm prefix $prefix is not writable without elevated rights" >&2; exit 75; fi',
  'reported="$("$npm_bin" prefix -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ "$reported" != "$prefix" ]; then echo "update: npm reports prefix [$reported] instead of [$prefix]" >&2; exit 76; fi',
  'if [ "$app_root" = "-" ]; then base="$HOME/.cache/wsl-web-shell"; else',
  'case "$app_root" in "~/"*) base="$HOME/${app_root#"~/"}" ;; /*) base="$app_root" ;; esac',
  '[ -d "$base" ] && base="$(cd "$base" && pwd -P)"',
  'fi',
  'cache="$base/cache/npm"',
  'mkdir -p "$cache" 2>/dev/null || true',
  NPM_ENV,
  'export npm_config_cache="$cache"',
  'echo "update: restoring ' + NPM_PACKAGE + '@$ver"',
  'if "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$ver"; then',
  'if [ "$(version_of "$dsh")" = "$ver" ]; then echo "update: restored $ver"; exit 0; fi',
  'echo "update: the installation reports [$(version_of "$dsh")] after restoring" >&2',
  'fi',
  'backup="$base/update/shared-backup-$tx"',
  'if [ -d "$backup" ] && [ "$pkg" != "-" ]; then',
  'echo "update: restoring the previous package from $backup" >&2',
  'if rm -rf "$pkg" && cp -a "$backup" "$pkg" && [ "$(version_of "$dsh")" = "$ver" ]; then echo "update: restored $ver"; exit 0; fi',
  'fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 74',
].join('\n');

export interface SharedUpdateRequest {
  distro: string;
  /** App data root inside the distribution (`-` when isolation is off). */
  appRoot: string;
  /** Absolute npm prefix reported by the inspection. */
  prefix: string;
  /** Package directory of the installation. */
  packageDir: string;
  /** Executable the launcher uses. */
  dshPath: string;
  npmPath: string;
  nodePath: string | null;
  transaction: string;
  version: string;
  installedVersion: string;
  /** PID of the app-owned backend, excluded from the foreign-process scan. */
  ownPid: number | null;
}

export interface InspectRequest {
  distro: string;
  appRoot: string;
  /** Executable to inspect, or `null` to let the script resolve one. */
  dshPath: string | null;
  nodePath: string | null;
  ownPid: number | null;
}

function appRootArg(value: string): string {
  if (value === '-') return '-';
  if (typeof value !== 'string' || !value.startsWith('/') && !value.startsWith('~/')) {
    throw new ArgumentError('invalid-app-root');
  }
  if (/[\0\r\n]/.test(value) || value.split('/').includes('..')) throw new ArgumentError('invalid-app-root');
  return value;
}

function pidArg(value: number | null): string {
  if (value === null) return '-';
  if (!Number.isInteger(value) || value <= 1 || value > 4_194_304) throw new ArgumentError('invalid-linux-pid');
  return String(value);
}

/** Read-only existence check of one exact published version. */
export function buildNpmViewArgs(request: { distro: string; appRoot: string; version: string; nodePath: string | null }): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(request.version)) throw new ArgumentError('invalid-version');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return ['-d', distro, '--exec', '/bin/sh', '-c', NPM_VIEW_SCRIPT, appRootArg(request.appRoot), request.version, request.nodePath ?? '-'];
}

/** Read-only provenance report of the installation in use. */
export function buildInspectSharedArgs(request: InspectRequest): string[] {
  const distro = assertDistroName(request.distro);
  const want = request.dshPath === null ? '-' : assertAbsolutePath(request.dshPath);
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return [
    '-d',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    INSPECT_SHARED_SCRIPT,
    want,
    appRootArg(request.appRoot),
    request.nodePath ?? '-',
    pidArg(request.ownPid),
  ];
}

/** Update the shared installation in place. */
export function buildUpdateSharedArgs(request: SharedUpdateRequest, transaction: string): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(request.version)) throw new ArgumentError('invalid-version');
  if (!isExactVersion(request.installedVersion)) throw new ArgumentError('invalid-version');
  const prefix = assertAbsolutePath(request.prefix);
  const dsh = assertAbsolutePath(request.dshPath);
  const pkg = request.packageDir === '' ? '-' : assertAbsolutePath(request.packageDir);
  if (!isValidRuntimeBinary(request.npmPath)) throw new ArgumentError('invalid-runtime-binary');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return [
    '-d',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    UPDATE_SHARED_SCRIPT,
    prefix,
    request.version,
    request.installedVersion,
    request.npmPath,
    request.nodePath ?? '-',
    assertTransaction(transaction),
    dsh,
    pkg,
    appRootArg(request.appRoot),
    pidArg(request.ownPid),
  ];
}

/** Reinstall the previous exact version. */
export function buildRollbackSharedArgs(
  request: Pick<SharedUpdateRequest, 'distro' | 'prefix' | 'packageDir' | 'dshPath' | 'npmPath' | 'nodePath' | 'appRoot'>,
  version: string,
  transaction: string,
): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(version)) throw new ArgumentError('invalid-version');
  const prefix = assertAbsolutePath(request.prefix);
  const dsh = assertAbsolutePath(request.dshPath);
  const pkg = request.packageDir === '' ? '-' : assertAbsolutePath(request.packageDir);
  if (!isValidRuntimeBinary(request.npmPath)) throw new ArgumentError('invalid-runtime-binary');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return [
    '-d',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    ROLLBACK_SHARED_SCRIPT,
    prefix,
    version,
    request.npmPath,
    request.nodePath ?? '-',
    dsh,
    pkg,
    assertTransaction(transaction),
    appRootArg(request.appRoot),
  ];
}

function assertTransaction(transaction: string): string {
  if (!isValidTransactionId(transaction)) throw new ArgumentError('invalid-transaction');
  return transaction;
}

const NPM_LINE = new RegExp(`^${NPM_MARKER} (.+)$`);

/** Parse the npm path announced by the lookup script. */
export function parseNpmMarker(line: string): string | null {
  const match = NPM_LINE.exec(line.trim());
  if (match === null) return null;
  const path = match[1]?.trim() ?? '';
  return isValidRuntimeBinary(path) ? path : null;
}
