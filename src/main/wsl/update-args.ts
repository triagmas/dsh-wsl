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
 *    manager, npm prefix, writability, login-shell resolution and foreign
 *    processes of the installation.
 * 3. `PREPARE_BACKUP_SCRIPT` — write-only into the app's own data root: creates a
 *    **verified, offline-restorable snapshot** of the package and its executable
 *    shim before anything else happens. A snapshot that cannot be created and
 *    verified stops the update while the installation is still untouched (B1).
 * 4. `UPDATE_SHARED_SCRIPT` — re-validates the whole installation identity at the
 *    last safe moment (pinned real path, canonical package directory, npm package
 *    identity, login-shell agreement, foreign processes), requires the verified
 *    snapshot, then runs `npm install -g` and proves that both the app-selected
 *    and the login-shell-selected executable report the exact target version at
 *    the approved real path. Any divergence fails the update and restores the
 *    snapshot (B2, B3).
 * 5. `ROLLBACK_SHARED_SCRIPT` — restores the verified snapshot offline (no
 *    registry, no npm needed) and only falls back to `npm install` of the
 *    previous exact version when the snapshot is unusable; validates every
 *    destination before replacing anything.
 *
 * Shared rules enforced by every script:
 * - versions, prefixes, paths and transaction ids are validated character by
 *   character;
 * - `npm prefix -g` must agree with the prefix the caller reported, so an
 *   environment override cannot redirect the install;
 * - the prefix must be writable without sudo/UAC — otherwise the app fails
 *   closed instead of escalating;
 * - nothing is written through a symlinked directory, no pre-existing backup is
 *   deleted, and no `dsh` process that the app does not own is signalled.
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidRuntimeBinary } from '../core/isolation.js';
import { isExactVersion, isValidTransactionId } from '../core/update.js';
import { INSPECT_MARKER } from '../core/dsh-locate.js';

export const NPM_PACKAGE = '@deepseek-ai/dsh' as const;

/** Marker printed by the npm view script right before the resolved npm path. */
export const NPM_MARKER = '__wsl_web_shell_npm__';

/** Marker printed by the backup script before every `key=value` line. */
export const BACKUP_MARKER = '__dsh_wsl_backup__';

/**
 * Self-identifying text embedded in every script that scans `/proc`.
 *
 * `sh -c <script> <args…>` puts the whole script — and therefore the approved
 * real path — into the command line of the shell and of every subshell it forks.
 * The foreign-process scan must not count those as "another DSH process", so any
 * command line carrying this marker is skipped. A real DeepSeek Harness process
 * never contains it.
 */
const SELF_MARKER = '__dsh_wsl_self__';

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
  `case "$cmd" in *"${SELF_MARKER}"*) continue ;; esac`,
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
 * App-owned backup directory resolution (B1).
 *
 * The snapshot always lives inside the app's own data root — never next to the
 * shared installation, never in the user's home directly — and every component
 * of that path is checked for symlinks before and after creation, so the snapshot
 * cannot be redirected outside the app tree. `$1` = app root (`-` when isolation
 * is off); prints `base`/`upd` through the globals of the same names.
 */
const BACKUP_BASE_HELPER = [
  'backup_base() {',
  'if [ "$1" = "-" ]; then base="$HOME/.cache/wsl-web-shell"; else',
  'case "$1" in "~/"*) base="$HOME/${1#"~/"}" ;; /*) base="$1" ;; *) echo "update: rejected app data root" >&2; return 1 ;; esac',
  'fi',
  '[ -n "$base" ] || { echo "update: no app data root" >&2; return 1; }',
  'mkdir -p "$base" 2>/dev/null || { echo "update: the app data root $base cannot be created" >&2; return 1; }',
  '[ ! -L "$base" ] || { echo "update: the app data root $base is a symlink" >&2; return 1; }',
  'base="$(cd "$base" && pwd -P)" || { echo "update: the app data root cannot be resolved" >&2; return 1; }',
  'upd="$base/update"',
  '[ ! -L "$upd" ] || { echo "update: the backup directory $upd is a symlink" >&2; return 1; }',
  'mkdir -p "$upd" 2>/dev/null || { echo "update: the backup directory $upd is not writable" >&2; return 1; }',
  '[ ! -L "$upd" ] || { echo "update: the backup directory $upd is a symlink" >&2; return 1; }',
  'canon="$(cd "$upd" && pwd -P)" || { echo "update: the backup directory cannot be resolved" >&2; return 1; }',
  '[ "$canon" = "$base/update" ] || { echo "update: the backup directory resolves to $canon" >&2; return 1; }',
  'upd="$canon"',
  'return 0',
  '}',
].join('\n');

/**
 * Is the directory a real directory that canonicalises to itself?
 *
 * Used before anything is deleted or replaced: a symlinked ancestor of the
 * package directory (`<prefix>/lib`, `<prefix>/lib/node_modules`,
 * `…/@deepseek-ai`) would otherwise redirect `rm -rf` outside the approved
 * installation (review C2).
 */
const REAL_DIR_HELPER = [
  'real_dir() {',
  '[ -d "$1" ] && [ ! -L "$1" ] || return 1',
  '[ "$(cd "$1" 2>/dev/null && pwd -P)" = "$1" ] || return 1',
  'return 0',
  '}',
].join('\n');

/**
 * Refuse any redirected or symlinked ancestry of the mutation target (C2).
 *
 * `$1` = npm prefix, `$2` = package directory, `$3` = executable shim.
 */
const DEST_TRUSTED_HELPER = [
  'dest_trusted() {',
  'pfx="$1"; target="$2"; shim="$3"',
  'real_dir "$pfx" || { echo "update: the npm prefix $pfx is not a real directory" >&2; return 1; }',
  'case "$target" in "$pfx"/lib/node_modules/?*|"$pfx"/node_modules/?*) ;; *) echo "update: $target is outside the npm prefix $pfx" >&2; return 1 ;; esac',
  'parent="$(dirname "$target")"',
  'rest="${parent#"$pfx"/}"',
  '[ -n "$rest" ] || { echo "update: unexpected package location $target" >&2; return 1; }',
  'cur="$pfx"',
  'while :; do',
  'case "$rest" in */*) part="${rest%%/*}"; rest="${rest#*/}" ;; *) part="$rest"; rest="" ;; esac',
  'cur="$cur/$part"',
  'real_dir "$cur" || { echo "update: $cur is not a real directory (symlinked or redirected)" >&2; return 1; }',
  '[ -z "$rest" ] && break',
  'done',
  '[ ! -L "$target" ] || { echo "update: $target is a symlink" >&2; return 1; }',
  'shim_dir="$(dirname "$shim")"',
  'real_dir "$shim_dir" || { echo "update: the executable directory $shim_dir is not a real directory" >&2; return 1; }',
  'return 0',
  '}',
].join('\n');

/**
 * Deterministic content manifest of a snapshot payload and its verification.
 *
 * `cksum` (POSIX) over a sorted relative file list detects truncated, altered or
 * removed files, so a snapshot that merely *looks* present can never be used to
 * delete a working installation (review C3).
 */
const MANIFEST_HELPER = [
  'manifest_of() {',
  '( cd "$1" && find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do cksum "$f"; done )',
  '}',
  'manifest_ok() {',
  '[ -d "$1/payload" ] && [ -f "$1/manifest" ] || return 1',
  'manifest_of "$1/payload" 2>/dev/null | cmp -s - "$1/manifest" || return 1',
  'want="$(meta_value files "$1/meta")"',
  'have="$(wc -l < "$1/manifest" 2>/dev/null | tr -d " ")"',
  '[ -z "$want" ] || [ "$want" = "$have" ] || return 1',
  'return 0',
  '}',
].join('\n');

/** Read one `key=value` line from a snapshot `meta` file. */
const META_HELPER = [
  'meta_value() {',
  '[ -f "$2" ] || return 1',
  'sed -n "s/^$1=//p" "$2" | head -n 1',
  '}',
].join('\n');

/**
 * Snapshot validation (B1).
 *
 * A snapshot is only usable when it is a real directory (not a link) below the
 * app root, carries a `meta` record, still contains the copied package, and its
 * payload really reports the version it claims. Callers additionally compare the
 * recorded identity with the installation they are about to change.
 *
 * `$1` = snapshot, `$2` = expected version.
 */
const SNAPSHOT_HELPER = [
  'snapshot_ok() {',
  'sn="$1"; want="$2"',
  '[ -n "$sn" ] && [ "$sn" != "-" ] || return 1',
  '[ -d "$sn" ] && [ ! -L "$sn" ] || return 1',
  '[ -f "$sn/meta" ] || return 1',
  '[ -d "$sn/payload" ] && [ ! -L "$sn/payload" ] || return 1',
  '[ -f "$sn/payload/package.json" ] || return 1',
  'sv="$(meta_value version "$sn/meta")" || return 1',
  '[ "$sv" = "$want" ] || return 1',
  'se="$(meta_value entry "$sn/meta")" || return 1',
  '[ -n "$se" ] || return 1',
  '[ -f "$sn/payload/$se" ] || return 1',
  'manifest_ok "$sn" || { echo "update: the snapshot at $sn failed its integrity check" >&2; return 1; }',
  'return 0',
  '}',
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
 * `package`, `writable`, `npm`, `foreign`, `loginreal`, `loginversion` and
 * `legacy` (an older private runtime still exists on disk; it is reported but not
 * selected). `loginreal`/`loginversion` describe what an ordinary login shell
 * resolves, so the caller can prove both sides use one installation.
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
  'login=""; loginreal="-"; loginversion="-"',
  'if command -v bash >/dev/null 2>&1; then',
  'login="$(bash -lc "command -v dsh" 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ -n "$login" ] && [ -x "$login" ]; then',
  'loginreal="$(readlink -f "$login" 2>/dev/null)" || loginreal="$login"',
  'loginversion="$(version_of "$login")"',
  '[ -n "$loginversion" ] || loginversion="-"',
  'fi',
  'fi',
  'dsh="$want"; source="custom"',
  'if [ "$dsh" = "-" ]; then',
  'source=""',
  'if [ -n "$login" ] && [ -x "$login" ]; then dsh="$login"; source="login-shell"; fi',
  'if [ -z "$source" ]; then p=$(command -v dsh 2>/dev/null); [ -n "$p" ] && [ -x "$p" ] && { dsh="$p"; source="path"; }; fi',
  'if [ -z "$source" ]; then for c in "$HOME/.local/bin/dsh" /usr/local/bin/dsh /usr/bin/dsh "$HOME/.npm-global/bin/dsh" "$HOME"/.nvm/versions/node/*/bin/dsh "$HOME"/.volta/bin/dsh; do',
  '[ -x "$c" ] && { dsh="$c"; source="fallback"; break; }; done; fi',
  'fi',
  'if [ -z "$dsh" ] || [ ! -x "$dsh" ]; then',
  `printf "%s found=no\\n" "${INSPECT_MARKER}"`,
  `printf "%s loginreal=%s\\n" "${INSPECT_MARKER}" "$loginreal"`,
  `printf "%s loginversion=%s\\n" "${INSPECT_MARKER}" "$loginversion"`,
  'exit 0',
  'fi',
  'real="$(readlink -f "$dsh" 2>/dev/null)" || real=""',
  '[ -n "$real" ] || real="$dsh"',
  'link=no; [ -L "$dsh" ] && link=yes',
  'ver="$(version_of "$dsh")"',
  `printf "%s found=yes\\n" "${INSPECT_MARKER}"`,
  `printf "%s path=%s\\n" "${INSPECT_MARKER}" "$dsh"`,
  `printf "%s real=%s\\n" "${INSPECT_MARKER}" "$real"`,
  `printf "%s link=%s\\n" "${INSPECT_MARKER}" "$link"`,
  `printf "%s source=%s\\n" "${INSPECT_MARKER}" "$source"`,
  `printf "%s version=%s\\n" "${INSPECT_MARKER}" "$ver"`,
  `printf "%s loginreal=%s\\n" "${INSPECT_MARKER}" "$loginreal"`,
  `printf "%s loginversion=%s\\n" "${INSPECT_MARKER}" "$loginversion"`,
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
 * Create and verify the offline recovery snapshot **before** anything is changed (B1).
 *
 * The snapshot lives in the app's own data root, is specific to the transaction
 * and records the immutable identity of the installation it belongs to: the
 * approved real path, the executable shim state (symlink target or copy), the
 * npm prefix, the package directory, the version and the entry point relative to
 * the package. It is created in `<update>/shared-backup-<tx>.tmp`, verified, and
 * only then renamed into place, so a half-copied snapshot is never mistaken for a
 * usable one. Nothing is deleted that this transaction did not create.
 *
 * Exit codes: 64 bad argument, 79 the backup location is unsafe or not writable,
 * 80 the snapshot could not be created or verified, 81 the installation identity
 * changed (path, package, version).
 *
 * `$0` = executable, `$1` = prefix, `$2` = package directory, `$3` = approved
 * real path, `$4` = installed version, `$5` = transaction id, `$6` = app data
 * root (`-` when isolation is off), `$7` = resolved Node runtime (`-` when
 * unknown).
 *
 * The npm launcher is normally a symlink to a script that starts with
 * `#!/usr/bin/env node`, so every version probe needs Node on PATH. A
 * `wsl.exe --exec /bin/sh` command starts with a minimal PATH that does not
 * contain the user's Node directory, so the resolved runtime is prepended here
 * exactly like the other update stages do — regardless of the isolation
 * setting. Without it the probe reported an empty version and the snapshot
 * failed with code 81 even though the installation was healthy (issue #27).
 */
export const PREPARE_BACKUP_SCRIPT = [
  'set -u',
  'dsh="$0"; prefix="$1"; pkg="$2"; real_path="$3"; installed="$4"; tx="$5"; app_root="$6"; node="${7:--}"',
  'case "$node" in "-") ;; /*) ;; *) echo "backup: rejected node runtime" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  'case "$installed" in ""|*[!0-9A-Za-z.-]*) echo "backup: rejected installed version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "backup: rejected transaction id" >&2; exit 64 ;; esac',
  'case "$prefix" in /*) ;; *) echo "backup: rejected npm prefix" >&2; exit 64 ;; esac',
  'case "$dsh" in /*) ;; *) echo "backup: rejected executable path" >&2; exit 64 ;; esac',
  'case "$pkg" in /*) ;; *) echo "backup: rejected package path" >&2; exit 64 ;; esac',
  'case "$real_path" in /*) ;; *) echo "backup: rejected real path" >&2; exit 64 ;; esac',
  VERSION_HELPER,
  META_HELPER,
  MANIFEST_HELPER,
  REAL_DIR_HELPER,
  DEST_TRUSTED_HELPER,
  SNAPSHOT_HELPER,
  BACKUP_BASE_HELPER,
  'backup_base "$app_root" || exit 79',
  'sn="$upd/shared-backup-$tx"',
  // C3: a pre-existing directory with this transaction's name is not ours.
  '[ -e "$sn" ] && { echo "backup: $sn already exists" >&2; exit 79; }',
  '[ -L "$sn" ] && { echo "backup: $sn is a symlink" >&2; exit 79; }',
  '[ -e "$sn.tmp" ] && { echo "backup: $sn.tmp already exists" >&2; exit 79; }',
  '[ -L "$sn.tmp" ] && { echo "backup: $sn.tmp is a symlink" >&2; exit 79; }',
  // Identity of the installation we are about to snapshot.
  'real="$(readlink -f "$dsh" 2>/dev/null)" || real=""',
  '[ "$real" = "$real_path" ] || { echo "backup: $dsh resolves to [$real] instead of [$real_path]" >&2; exit 81; }',
  '[ -d "$pkg" ] && [ ! -L "$pkg" ] || { echo "backup: $pkg is not a real directory" >&2; exit 81; }',
  'pkg_canon="$(cd "$pkg" && pwd -P)" || { echo "backup: $pkg cannot be resolved" >&2; exit 81; }',
  '[ "$pkg_canon" = "$pkg" ] || { echo "backup: $pkg resolves to $pkg_canon" >&2; exit 81; }',
  'dest_trusted "$prefix" "$pkg" "$dsh" || exit 81',
  'case "$real" in "$pkg"/*) ;; *) echo "backup: $dsh is outside the package $pkg" >&2; exit 81 ;; esac',
  'grep -q "\\"name\\"[[:space:]]*:[[:space:]]*\\"' + NPM_PACKAGE + '\\"" "$pkg/package.json" 2>/dev/null || { echo "backup: $pkg is not ' + NPM_PACKAGE + '" >&2; exit 81; }',
  'have="$(version_of "$dsh")"',
  '[ "$have" = "$installed" ] || { echo "backup: $dsh reports [$have] instead of [$installed]" >&2; exit 81; }',
  'entry="${real#"$pkg"/}"',
  '[ -n "$entry" ] && [ "$entry" != "$real" ] || { echo "backup: the executable is not inside the package" >&2; exit 81; }',
  // Copy and verify. Only a directory this invocation created is ever removed.
  'created=no',
  'cleanup() { [ "$created" = "yes" ] && rm -rf "$sn.tmp" 2>/dev/null; }',
  'mkdir -p "$sn.tmp/payload" 2>/dev/null || { echo "backup: $sn.tmp cannot be created" >&2; exit 80; }',
  'created=yes',
  'if ! cp -a "$pkg/." "$sn.tmp/payload/" 2>/dev/null; then echo "backup: the package could not be copied (free space?)" >&2; cleanup; exit 80; fi',
  '[ -f "$sn.tmp/payload/package.json" ] || { echo "backup: the copied package is incomplete" >&2; cleanup; exit 80; }',
  '[ -f "$sn.tmp/payload/$entry" ] || { echo "backup: the copied entry point $entry is missing" >&2; cleanup; exit 80; }',
  'copied="$(version_of "$sn.tmp/payload/$entry")"',
  '[ "$copied" = "$installed" ] || { echo "backup: the copied executable reports [$copied] instead of [$installed]" >&2; cleanup; exit 80; }',
  'manifest_of "$sn.tmp/payload" > "$sn.tmp/manifest" 2>/dev/null || { echo "backup: the content manifest could not be written" >&2; cleanup; exit 80; }',
  'files="$(wc -l < "$sn.tmp/manifest" 2>/dev/null | tr -d " ")"',
  '[ -n "$files" ] && [ "$files" -gt 0 ] || { echo "backup: the copied package contains no files" >&2; cleanup; exit 80; }',
  // Executable state: a symlink target or a copy of the shim file.
  'link=no; link_target="-"',
  'if [ -L "$dsh" ]; then link=yes; link_target="$(readlink "$dsh")"; [ -n "$link_target" ] || { echo "backup: the shim $dsh has no target" >&2; cleanup; exit 80; }; printf "%s" "$link_target" > "$sn.tmp/dsh.link" || { cleanup; exit 80; }; fi',
  'if [ "$link" = "no" ]; then [ -f "$dsh" ] || { echo "backup: $dsh is neither a file nor a symlink" >&2; cleanup; exit 80; }; cp -a "$dsh" "$sn.tmp/dsh" || { echo "backup: $dsh could not be copied" >&2; cleanup; exit 80; }; fi',
  '{',
  'printf "version=%s\\n" "$installed"',
  'printf "real=%s\\n" "$real_path"',
  'printf "dsh=%s\\n" "$dsh"',
  'printf "link=%s\\n" "$link"',
  'printf "linktarget=%s\\n" "$link_target"',
  'printf "prefix=%s\\n" "$prefix"',
  'printf "package=%s\\n" "$pkg"',
  'printf "entry=%s\\n" "$entry"',
  'printf "files=%s\\n" "$files"',
  'printf "transaction=%s\\n" "$tx"',
  '} > "$sn.tmp/meta" || { echo "backup: the snapshot record could not be written" >&2; cleanup; exit 80; }',
  'mv "$sn.tmp" "$sn" 2>/dev/null || { echo "backup: the snapshot could not be moved into place" >&2; cleanup; exit 80; }',
  'created=no',
  'snapshot_ok "$sn" "$installed" || { echo "backup: the finished snapshot did not verify" >&2; exit 80; }',
  `printf "%s path=%s\\n" "${BACKUP_MARKER}" "$sn"`,
  `printf "%s version=%s\\n" "${BACKUP_MARKER}" "$installed"`,
  `printf "%s real=%s\\n" "${BACKUP_MARKER}" "$real_path"`,
  `printf "%s package=%s\\n" "${BACKUP_MARKER}" "$pkg"`,
  `printf "%s files=%s\\n" "${BACKUP_MARKER}" "$files"`,
  'exit 0',
].join('\n');

/**
 * Install the exact target version into the prefix the installation already uses.
 *
 * Nothing is changed before **all** of these hold: the verified snapshot exists
 * and belongs to this very installation; `npm prefix -g` agrees; the prefix is
 * writable without elevation; the executable still resolves to the approved real
 * path inside the canonical package directory of the expected npm package; the
 * installation reports the expected current version; the login shell resolves the
 * same file; and no foreign DSH process uses it.
 *
 * After npm succeeds the same invariants are checked again — including the
 * version a login shell sees. A disagreement is a failure, not a warning: the
 * snapshot is restored offline and the run exits non-zero (B3).
 *
 * Exit codes: 64 bad argument, 69 no npm, 71 the installation does not report the
 * expected current version, 72 install failed and the previous version was
 * restored, 73 install failed and the restore failed, 74 the new version does not
 * report the target version (restore attempted), 75 the prefix is not writable,
 * 76 npm reports a different prefix, 77 the installation is already at the target
 * version, 78 another DSH process uses this installation, 79 the snapshot path is
 * unsafe, 80 the verified snapshot is missing or unusable (nothing was changed),
 * 81 the installation identity changed since the plan (nothing was changed),
 * 82 the login shell resolves a different installation (nothing was changed),
 * 83 the installation moved away from the approved real path (restore attempted),
 * 84 the login shell does not run the updated version (restore attempted).
 *
 * `$0` = prefix, `$1` = target version, `$2` = installed version, `$3` = npm,
 * `$4` = node (or `-`), `$5` = transaction id, `$6` = executable,
 * `$7` = package directory, `$8` = app data root (`-`), `$9` = app-owned PID (`-`),
 * `${10}` = approved real path, `${11}` = verified snapshot directory.
 */
export const UPDATE_SHARED_SCRIPT = [
  'set -u',
  'prefix="$0"; ver="$1"; installed="$2"; npm_bin="$3"; node="$4"; tx="$5"; dsh="$6"; pkg="$7"; app_root="$8"; own="$9"',
  'real_path="${10:-}"; snapshot="${11:-}"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$installed" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected installed version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'case "$prefix" in /*) ;; *) echo "update: rejected npm prefix" >&2; exit 64 ;; esac',
  'case "$dsh" in /*) ;; *) echo "update: rejected executable path" >&2; exit 64 ;; esac',
  'case "$pkg" in /*) ;; *) echo "update: rejected package path" >&2; exit 64 ;; esac',
  'case "$real_path" in /*) ;; *) echo "update: rejected real path" >&2; exit 64 ;; esac',
  'case "$snapshot" in /*) ;; *) echo "update: rejected snapshot path" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  VERSION_HELPER,
  FOREIGN_HELPER,
  META_HELPER,
  MANIFEST_HELPER,
  REAL_DIR_HELPER,
  DEST_TRUSTED_HELPER,
  BACKUP_BASE_HELPER,
  SNAPSHOT_HELPER,
  // 1. App-owned backup location and the verified snapshot of *this* installation.
  'backup_base "$app_root" || exit 79',
  'expected="$upd/shared-backup-$tx"',
  '[ "$snapshot" = "$expected" ] || { echo "update: the snapshot path [$snapshot] is not the expected [$expected]" >&2; exit 79; }',
  '[ ! -L "$snapshot" ] || { echo "update: the snapshot $snapshot is a symlink" >&2; exit 79; }',
  'snapshot_ok "$snapshot" "$installed" || { echo "update: the verified snapshot at $snapshot is missing or incomplete, so nothing was changed" >&2; exit 80; }',
  'snap_real="$(meta_value real "$snapshot/meta")"; snap_pkg="$(meta_value package "$snapshot/meta")"; snap_dsh="$(meta_value dsh "$snapshot/meta")"',
  '[ "$snap_real" = "$real_path" ] && [ "$snap_pkg" = "$pkg" ] && [ "$snap_dsh" = "$dsh" ] || { echo "update: the snapshot belongs to a different installation, so nothing was changed" >&2; exit 80; }',
  // 2. npm and prefix agreement.
  'if [ -z "$npm_bin" ] || [ "$npm_bin" = "-" ] || [ ! -x "$npm_bin" ]; then echo "update: npm was not found in this distribution" >&2; exit 69; fi',
  'reported="$("$npm_bin" prefix -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ "$reported" != "$prefix" ]; then echo "update: npm reports prefix [$reported] instead of [$prefix]" >&2; exit 76; fi',
  'if [ ! -w "$prefix" ]; then echo "update: the npm prefix $prefix is not writable without elevated rights" >&2; exit 75; fi',
  'if [ -d "$prefix/lib/node_modules" ] && [ ! -w "$prefix/lib/node_modules" ]; then echo "update: $prefix/lib/node_modules is not writable without elevated rights" >&2; exit 75; fi',
  // 3. Installation identity at the last safe moment (B2).
  'real="$(readlink -f "$dsh" 2>/dev/null)" || real=""',
  '[ "$real" = "$real_path" ] || { echo "update: $dsh now resolves to [$real] instead of the approved [$real_path], so nothing was changed" >&2; exit 81; }',
  '[ -d "$pkg" ] && [ ! -L "$pkg" ] || { echo "update: $pkg is no longer the expected real package directory, so nothing was changed" >&2; exit 81; }',
  'pkg_canon="$(cd "$pkg" && pwd -P 2>/dev/null)" || pkg_canon=""',
  '[ "$pkg_canon" = "$pkg" ] || { echo "update: $pkg resolves to [$pkg_canon], so nothing was changed" >&2; exit 81; }',
  'case "$pkg" in "$prefix"/lib/node_modules/*|"$prefix"/node_modules/*) ;; *) echo "update: $pkg is not inside the npm prefix $prefix, so nothing was changed" >&2; exit 81 ;; esac',
  'case "$real" in "$pkg"/*) ;; *) echo "update: $dsh points outside the package $pkg, so nothing was changed" >&2; exit 81 ;; esac',
  'dest_trusted "$prefix" "$pkg" "$dsh" || { echo "update: the installation path is redirected, so nothing was changed" >&2; exit 81; }',
  'grep -q "\\"name\\"[[:space:]]*:[[:space:]]*\\"' + NPM_PACKAGE + '\\"" "$pkg/package.json" 2>/dev/null || { echo "update: $pkg is not an ' + NPM_PACKAGE + ' package, so nothing was changed" >&2; exit 81; }',
  'now="$(version_of "$dsh")"',
  'if [ "$now" = "$ver" ]; then echo "update: the installation already reports $ver" >&2; exit 77; fi',
  'if [ "$now" != "$installed" ]; then echo "update: the installation reports [$now], expected [$installed]" >&2; exit 71; fi',
  // 4. The ordinary terminal must run this very file (B3, before and after).
  'login=""; login_real="-"',
  'if command -v bash >/dev/null 2>&1; then login="$(bash -lc "command -v dsh" 2>/dev/null | tr -d "\\r" | tail -n 1)"; fi',
  'if [ -n "$login" ] && [ -x "$login" ]; then login_real="$(readlink -f "$login" 2>/dev/null)" || login_real="$login"; fi',
  // C1: "unknown" is not agreement. No bash, no `dsh` on the shell PATH or an
  // unparsable version all stop the update before anything is written.
  'if [ -z "$login" ] || [ ! -x "$login" ]; then echo "update: a login shell cannot resolve dsh (bash -lc printed nothing), so the update cannot change the CLI you use in a terminal; nothing was changed" >&2; exit 82; fi',
  'login_before="$(version_of "$login")"',
  'if [ "$login_before" != "$installed" ]; then echo "update: a login shell reports [$login_before] for $login instead of [$installed], so nothing was changed" >&2; exit 82; fi',
  'if [ "$login_real" != "$real" ]; then echo "update: a login shell resolves [$login] ($login_real) instead of the approved installation, so nothing was changed" >&2; exit 82; fi',
  // 5. Nobody else may be using the installation.
  'foreign="$(foreign_count "$real" "$own")"',
  'if [ "$foreign" != "0" ]; then echo "update: $foreign other DeepSeek Harness process(es) use $dsh" >&2; exit 78; fi',
  // 6. Offline-first restore from the verified snapshot.
  'restore_snapshot() {',
  'snapshot_ok "$snapshot" "$installed" || { echo "update: the snapshot is not usable any more" >&2; return 1; }',
  'target="$pkg"',
  // C2: no symlinked ancestor and no redirected destination may be replaced.
  'dest_trusted "$prefix" "$target" "$dsh" || { echo "update: refusing to restore into a redirected installation path" >&2; return 1; }',
  'mkdir -p "$(dirname "$target")" 2>/dev/null || return 1',
  'rm -rf "$target" || { echo "update: $target could not be replaced" >&2; return 1; }',
  'cp -a "$snapshot/payload/." "$target/" || { echo "update: the snapshot could not be copied back" >&2; return 1; }',
  'if [ -f "$snapshot/dsh.link" ]; then',
  'want_link="$(cat "$snapshot/dsh.link")"',
  '[ -n "$want_link" ] || return 1',
  'ln -sfn "$want_link" "$dsh" || return 1',
  'else',
  '[ -f "$snapshot/dsh" ] || return 1',
  'cp -a "$snapshot/dsh" "$dsh" || return 1',
  'fi',
  'restored_real="$(readlink -f "$dsh" 2>/dev/null)" || restored_real=""',
  '[ "$restored_real" = "$real_path" ] || { echo "update: the restored executable resolves to [$restored_real]" >&2; return 1; }',
  '[ "$(version_of "$dsh")" = "$installed" ] || { echo "update: the restored executable does not report $installed" >&2; return 1; }',
  'echo "update: restored $installed from the verified snapshot" >&2',
  'return 0',
  '}',
  'restore() {',
  'if restore_snapshot; then return 0; fi',
  'echo "update: falling back to reinstalling ' + NPM_PACKAGE + '@$installed with npm" >&2',
  'if "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$installed" >/dev/null 2>&1; then',
  'if [ "$(version_of "$dsh")" = "$installed" ]; then return 0; fi',
  'fi',
  'return 1',
  '}',
  'cache="$base/cache/npm"',
  'mkdir -p "$cache" 2>/dev/null || true',
  NPM_ENV,
  'export npm_config_cache="$cache"',
  'echo "update: installing ' + NPM_PACKAGE + '@$ver into $prefix"',
  'echo "update: npm $npm_bin"',
  'echo "update: recovery snapshot at $snapshot"',
  'if ! "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$ver"; then',
  'echo "update: npm install failed" >&2',
  'if restore; then echo "update: previous version restored"; exit 72; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  // 7. Proof: same file, same approved path, exact version, and the shell too.
  'echo "update: verifying $dsh"',
  'new="$(version_of "$dsh")"',
  'if [ "$new" != "$ver" ]; then',
  'echo "update: the installation reports [$new] instead of [$ver]" >&2',
  'if restore; then echo "update: previous version restored"; exit 74; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  'after_real="$(readlink -f "$dsh" 2>/dev/null)" || after_real=""',
  'if [ "$after_real" != "$real_path" ]; then',
  'echo "update: the installation moved to [$after_real] instead of [$real_path]" >&2',
  'if restore; then echo "update: previous version restored"; exit 83; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  'if [ "$login_real" != "-" ]; then',
  'login_after="$(bash -lc "command -v dsh" 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'login_after_real="$(readlink -f "$login_after" 2>/dev/null)" || login_after_real=""',
  'login_version="-"; [ -n "$login_after" ] && [ -x "$login_after" ] && login_version="$(version_of "$login_after")"',
  'if [ "$login_after_real" != "$real_path" ] || [ "$login_version" != "$ver" ]; then',
  'echo "update: a login shell resolves [$login_after] ($login_after_real, version [$login_version]) instead of the updated installation" >&2',
  'if restore; then echo "update: previous version restored"; exit 84; fi',
  'echo "update: the previous version could not be restored" >&2',
  'exit 73',
  'fi',
  'echo "update: a login shell resolves the updated executable ($login_after)"',
  'fi',
  'echo "update: verified snapshot kept at $snapshot"',
  'exit 0',
].join('\n');

/**
 * Restore the previous installation offline (failure path and journal recovery).
 *
 * The verified snapshot is the primary recovery path: it needs no registry, no
 * npm and no network. `npm install` of the previous exact version is only a
 * fallback for a snapshot that is not usable any more. Every destination is
 * re-validated (real path, non-symlink, containment in the reported prefix)
 * before anything is replaced, so a rollback can never write through a redirected
 * path; when neither path is possible the script exits `74` and the caller keeps
 * the journal and blocks further starts.
 *
 * Exit codes: 64 bad argument, 69 no npm, 74 the previous version could not be
 * restored, 75 not writable, 76 npm prefix disagreement, 79 the snapshot path is
 * unsafe, 81 the destination is not the expected installation.
 *
 * `$0` = prefix, `$1` = version to restore, `$2` = npm, `$3` = node (or `-`),
 * `$4` = executable, `$5` = package directory, `$6` = transaction id,
 * `$7` = app data root (`-`), `$8` = approved real path,
 * `$9` = verified snapshot directory.
 */
export const ROLLBACK_SHARED_SCRIPT = [
  'set -u',
  'prefix="$0"; ver="$1"; npm_bin="$2"; node="$3"; dsh="$4"; pkg="$5"; tx="$6"; app_root="$7"; real_path="${8:-}"; snapshot="${9:-}"',
  'case "$ver" in ""|*[!0-9A-Za-z.-]*) echo "update: rejected version" >&2; exit 64 ;; esac',
  'case "$tx" in ""|*[!0-9A-Za-z-]*) echo "update: rejected transaction id" >&2; exit 64 ;; esac',
  'case "$prefix" in /*) ;; *) echo "update: rejected npm prefix" >&2; exit 64 ;; esac',
  'case "$dsh" in /*) ;; *) echo "update: rejected executable path" >&2; exit 64 ;; esac',
  'case "$pkg" in /*) ;; *) echo "update: rejected package path" >&2; exit 64 ;; esac',
  'case "$real_path" in /*) ;; *) echo "update: rejected real path" >&2; exit 64 ;; esac',
  'case "$snapshot" in /*) ;; *) echo "update: rejected snapshot path" >&2; exit 64 ;; esac',
  'if [ "$node" != "-" ] && [ -n "$node" ]; then PATH="$(dirname "$node"):$PATH"; export PATH; fi',
  VERSION_HELPER,
  META_HELPER,
  MANIFEST_HELPER,
  REAL_DIR_HELPER,
  DEST_TRUSTED_HELPER,
  BACKUP_BASE_HELPER,
  SNAPSHOT_HELPER,
  'backup_base "$app_root" || exit 79',
  'expected="$upd/shared-backup-$tx"',
  '[ "$snapshot" = "$expected" ] || { echo "update: the snapshot path [$snapshot] is not the expected [$expected]" >&2; exit 79; }',
  '[ ! -L "$snapshot" ] || { echo "update: the snapshot $snapshot is a symlink" >&2; exit 79; }',
  // Destination ownership before any destructive step (C2): the whole ancestry
  // and the executable's directory must be real, canonical directories.
  'dest_trusted "$prefix" "$pkg" "$dsh" || { echo "update: refusing to restore into a redirected installation path" >&2; exit 81; }',
  'if snapshot_ok "$snapshot" "$ver"; then',
  'snap_pkg="$(meta_value package "$snapshot/meta")"; snap_real="$(meta_value real "$snapshot/meta")"',
  'if [ "$snap_pkg" = "$pkg" ] && [ "$snap_real" = "$real_path" ]; then',
  'echo "update: restoring $ver from the verified snapshot $snapshot"',
  'mkdir -p "$(dirname "$pkg")" 2>/dev/null || true',
  'if rm -rf "$pkg" && cp -a "$snapshot/payload/." "$pkg/"; then',
  'if [ -f "$snapshot/dsh.link" ]; then want_link="$(cat "$snapshot/dsh.link")"; [ -n "$want_link" ] && ln -sfn "$want_link" "$dsh"; else [ -f "$snapshot/dsh" ] && cp -a "$snapshot/dsh" "$dsh"; fi',
  'restored_real="$(readlink -f "$dsh" 2>/dev/null)" || restored_real=""',
  'if [ "$(version_of "$dsh")" = "$ver" ] && [ "$restored_real" = "$real_path" ]; then echo "update: restored $ver"; exit 0; fi',
  'echo "update: the restored installation reports [$(version_of "$dsh")] at [$restored_real]" >&2',
  'fi',
  'else',
  'echo "update: the snapshot does not belong to this installation" >&2',
  'fi',
  'fi',
  // Fallback: reinstall the exact version with npm (needs a registry).
  'if [ -z "$npm_bin" ] || [ "$npm_bin" = "-" ] || [ ! -x "$npm_bin" ]; then echo "update: npm was not found in this distribution" >&2; exit 74; fi',
  'if [ ! -w "$prefix" ]; then echo "update: the npm prefix $prefix is not writable without elevated rights" >&2; exit 75; fi',
  'reported="$("$npm_bin" prefix -g 2>/dev/null | tr -d "\\r" | tail -n 1)"',
  'if [ "$reported" != "$prefix" ]; then echo "update: npm reports prefix [$reported] instead of [$prefix]" >&2; exit 76; fi',
  'cache="$base/cache/npm"',
  'mkdir -p "$cache" 2>/dev/null || true',
  NPM_ENV,
  'export npm_config_cache="$cache"',
  'echo "update: the snapshot is unusable, reinstalling ' + NPM_PACKAGE + '@$ver with npm"',
  'if "$npm_bin" install --global --prefix "$prefix" --cache "$cache" --no-audit --no-fund --loglevel=warn "' + NPM_PACKAGE + '@$ver"; then',
  'if [ "$(version_of "$dsh")" = "$ver" ]; then echo "update: restored $ver"; exit 0; fi',
  'echo "update: the installation reports [$(version_of "$dsh")] after restoring" >&2',
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
  /** Approved `readlink -f` of that executable (pinned by the plan). */
  realPath: string;
  npmPath: string;
  nodePath: string | null;
  transaction: string;
  version: string;
  installedVersion: string;
  /** PID of the app-owned backend, excluded from the foreign-process scan. */
  ownPid: number | null;
  /** Verified snapshot prepared by `PREPARE_BACKUP_SCRIPT` (B1). */
  snapshotDir: string;
}

export interface BackupRequest {
  distro: string;
  appRoot: string;
  prefix: string;
  packageDir: string;
  dshPath: string;
  realPath: string;
  installedVersion: string;
  transaction: string;
  /** Resolved Node runtime, or `null` when it is not known (probe may then fail). */
  nodePath: string | null;
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

/** Create the verified offline recovery snapshot before anything is changed. */
export function buildPrepareBackupArgs(request: BackupRequest): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(request.installedVersion)) throw new ArgumentError('invalid-version');
  const prefix = assertAbsolutePath(request.prefix);
  const dsh = assertAbsolutePath(request.dshPath);
  const realPath = assertAbsolutePath(request.realPath);
  const pkg = assertAbsolutePath(request.packageDir);
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  return [
    '-d',
    distro,
    '--exec',
    '/bin/sh',
    '-c',
    PREPARE_BACKUP_SCRIPT,
    dsh,
    prefix,
    pkg,
    realPath,
    request.installedVersion,
    assertTransaction(request.transaction),
    appRootArg(request.appRoot),
    request.nodePath ?? '-',
  ];
}

/** Update the shared installation in place. */
export function buildUpdateSharedArgs(request: SharedUpdateRequest, transaction: string): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(request.version)) throw new ArgumentError('invalid-version');
  if (!isExactVersion(request.installedVersion)) throw new ArgumentError('invalid-version');
  const prefix = assertAbsolutePath(request.prefix);
  const dsh = assertAbsolutePath(request.dshPath);
  const realPath = assertAbsolutePath(request.realPath);
  const pkg = request.packageDir === '' ? '-' : assertAbsolutePath(request.packageDir);
  if (!isValidRuntimeBinary(request.npmPath)) throw new ArgumentError('invalid-runtime-binary');
  if (request.nodePath !== null && !isValidRuntimeBinary(request.nodePath)) {
    throw new ArgumentError('invalid-runtime-binary');
  }
  const tx = assertTransaction(transaction);
  const snapshot = `${assertAbsolutePath(request.snapshotDir)}`;
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
    tx,
    dsh,
    pkg,
    appRootArg(request.appRoot),
    pidArg(request.ownPid),
    realPath,
    snapshot,
  ];
}

/** Restore the previous installation from the verified snapshot (offline first). */
export function buildRollbackSharedArgs(
  request: Pick<
    SharedUpdateRequest,
    'distro' | 'prefix' | 'packageDir' | 'dshPath' | 'realPath' | 'npmPath' | 'nodePath' | 'appRoot' | 'snapshotDir'
  >,
  version: string,
  transaction: string,
): string[] {
  const distro = assertDistroName(request.distro);
  if (!isExactVersion(version)) throw new ArgumentError('invalid-version');
  const prefix = assertAbsolutePath(request.prefix);
  const dsh = assertAbsolutePath(request.dshPath);
  const realPath = assertAbsolutePath(request.realPath);
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
    realPath,
    assertAbsolutePath(request.snapshotDir),
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

export interface BackupReport {
  /** Verified snapshot directory inside the app data root. */
  path: string;
  version: string;
  realPath: string;
  packageDir: string;
  files: number;
}

const BACKUP_LINE = new RegExp(`^${BACKUP_MARKER} ([a-z]+)=(.*)$`);

/** Parse the snapshot report; `null` when the report is incomplete or malformed. */
export function parseBackupReport(text: string): BackupReport | null {
  const fields = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const match = BACKUP_LINE.exec(rawLine.trim());
    if (match === null) continue;
    fields.set(match[1] ?? '', match[2] ?? '');
  }
  const path = fields.get('path');
  const version = fields.get('version');
  const realPath = fields.get('real');
  const packageDir = fields.get('package');
  const files = Number.parseInt(fields.get('files') ?? '', 10);
  if (path === undefined || version === undefined || realPath === undefined || packageDir === undefined) return null;
  if (!isValidRuntimeBinary(path) || !isExactVersion(version) || !isValidRuntimeBinary(realPath) || !isValidRuntimeBinary(packageDir)) {
    return null;
  }
  if (!Number.isFinite(files) || files <= 0) return null;
  return { path, version, realPath, packageDir, files };
}
