/**
 * Read-only inspection of the installation the launcher uses (issue #17).
 *
 * Moved out of the former updater: DSH WSL no longer replaces the installation,
 * but the manual instructions still need the exact executable, the package
 * manager, the prefix and the processes that run from it. The script only reads
 * and prints; it never writes, installs or signals anything.
 */
import { ArgumentError, assertDistroName } from './args.js';
import { isValidRuntimeBinary } from '../core/isolation.js';
import { DSH_PACKAGE } from '../core/manual-update.js';
import { INSPECT_MARKER } from '../core/dsh-locate.js';

/** Absolute POSIX path with the strict charset used everywhere else. */
const SAFE_PATH = /^\/[A-Za-z0-9._~/@+-]*$/;

/**
 * Self-identifying text embedded in the script that scans `/proc`.
 *
 * `sh -c <script> <args…>` puts the whole script into the command line of the
 * shell and of every subshell it forks. The process scan must not count those as
 * "another DSH process", so any command line carrying this marker is skipped.
 */
const SELF_MARKER = '__dsh_wsl_self__';

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
 * List the pids that run from the inspected installation.
 *
 * The report is informational: the app never signals these processes. `$1` is
 * the real executable path, `$2` the app-owned pid to exclude (`-` for none).
 * The scan excludes itself through {@link SELF_MARKER}.
 */
const FOREIGN_HELPER = [
  'foreign_list() {',
  'target="$1"; own="$2"; out=""',
  'for d in /proc/[0-9]*; do',
  'pid="${d#/proc/}"',
  '[ "$pid" = "$$" ] && continue',
  '[ "$own" != "-" ] && [ "$pid" = "$own" ] && continue',
  '[ -r "$d/cmdline" ] || continue',
  'cmd="$(tr "\\000" " " < "$d/cmdline" 2>/dev/null || true)"',
  `case "$cmd" in *"${SELF_MARKER}"*) continue ;; esac`,
  'case "$cmd" in *"$target"*) out="$out${out:+,}$pid" ;; esac',
  'done',
  'printf "%s" "$out"',
  '}',
  'foreign_count() {',
  'target="$1"; own="$2"; n=0',
  'for pid in $(printf "%s" "$(foreign_list "$target" "$own")" | tr "," " "); do n=$((n+1)); done',
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

/**
 * Read-only provenance report of the installation in use.
 *
 * `$0` = executable (`-` to resolve it here), `$1` = app data root (`-`),
 * `$2` = node (or `-`), `$3` = app-owned PID to exclude (`-`). Every line is a
 * marker followed by one `key=value` pair; unknown values are printed as `-`.
 * Exit code 64 means a malformed argument, never a partial mutation.
 */
export const INSPECT_SCRIPT = [
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
  `cand="$prefix/$layout/${DSH_PACKAGE}"`,
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
  `printf "%s foreignpids=%s\\n" "${INSPECT_MARKER}" "$(foreign_list "$real" "$own")"`,
  'exit 0',
].join('\n');

export interface InspectRequest {
  distro: string;
  /** App data root used only to report the legacy runtime presence. */
  appRoot: string;
  /** Executable to inspect; `null` resolves the distribution's own `dsh`. */
  dshPath: string | null;
  nodePath: string | null;
  /** App-owned backend pid excluded from the process list, `null` for none. */
  ownPid: number | null;
}

function appRootArg(value: string): string {
  if (value === '') return '-';
  if (!SAFE_PATH.test(value) && !value.startsWith('~/')) throw new ArgumentError('invalid-app-root');
  if (/[\0\r\n]/.test(value) || value.split('/').includes('..')) throw new ArgumentError('invalid-app-root');
  return value;
}

function pidArg(value: number | null): string {
  if (value === null) return '-';
  if (!Number.isInteger(value) || value <= 1 || value > 4_194_304) throw new ArgumentError('invalid-linux-pid');
  return String(value);
}

/** Arguments for the read-only inspection of the installation in use. */
export function buildInspectArgs(request: InspectRequest): string[] {
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
    INSPECT_SCRIPT,
    want,
    appRootArg(request.appRoot),
    request.nodePath ?? '-',
    pidArg(request.ownPid),
  ];
}
