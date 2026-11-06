# Architecture

Implementation notes for M1 (`R00` + `R01`). The product contract lives in
[spec.md](spec.md); the upstream backend contract in
[upstream-dsh-web.md](upstream-dsh-web.md).

## Process model

```text
Windows
└─ WSL Web Shell.exe (Electron main + isolated Chromium renderers)
   ├─ Supervisor (main process, no renderer code)
   │  ├─ wsl.exe gateway: distro list/start, dsh resolution, spawn, /proc probe, signals
   │  ├─ loopback port probe + owned-PID registry (userData/owned-server.json)
   │  └─ health loop (10 s visible / 25 s hidden, two failures => recovery)
   ├─ splash window  : frameless local page, orbital loader + error/retry
   ├─ settings window: local page, validated patch -> config.json
   └─ backend window : partition "persist:wsl-web-shell", no preload, sandboxed
        ⇅ http://127.0.0.1:<port>
      Ubuntu (existing) → dsh web --host 127.0.0.1 --port <port> --no-open
```

Everything under `src/main/core/` is Electron-free and unit-tested; Electron
integration is limited to `src/main/electron/*` and `src/main/index.ts`.

## Lifecycle

`CHECKING → STARTING_WSL → STARTING_WEB → CONNECTING → READY ↔ HIDDEN_IN_TRAY`,
plus `RECOVERING`, `ERROR`, `QUITTING`. `src/main/core/lifecycle.ts` holds the
transition allowlist; illegal jumps throw instead of silently mutating state.

All entry points (`start`, `restart`, `retry`, `shutdown`) go through one promise
chain, so two launches can never spawn two servers. `start()` is also idempotent
while a backend is already owned and healthy.

### Isolated backend environment

The backend never inherits a shared harness home. Every launch derives one
validated root — `~/.local/share/wsl-web-shell` by default — and puts the private
runtime, `DSH_HOME`, `DSH_AGENTS_HOME`, caches, temp files and the test workspace
below it (`src/main/core/isolation.ts`):

| Path | Purpose |
|---|---|
| `<root>/runtime/bin` | private npm prefix: the isolated `dsh` install lives here |
| `<root>/dsh-home` | `DSH_HOME`: harness config, credentials, sessions |
| `<root>/agents` | `DSH_AGENTS_HOME`: keeps the shared `~/.agents` out of the backend |
| `<root>/cache`, `<root>/tmp` | `XDG_CACHE_HOME`, `TMPDIR` |
| `<root>/workspace` | test workspace used when the configured workspace is the bare `~` |

**Root rules.** The root must be a dedicated, application-owned subtree at least
two components deep. `/`, `~`, `~/`, `~/x`, `/srv`, `~user/...`, empty or
repeated separators, `.`/`..` segments and any shell-significant character
(space, quote, `$`, `;`, `|`, `&`, backslash) are rejected in the TypeScript
validator **and** again inside the distribution before the first write. A root
equal to the home directory is rejected as well. Trailing slashes are normalised
away so the launcher and the plan always see the same string.

**Symlink rules.** Before anything is created, every component from the home
directory (or from `/` for absolute roots) down to the root is checked with
`-L`; the root itself and every managed subdirectory are re-checked before and
after `mkdir -p`, and each created directory must canonicalise to its expected
path (`cd … && pwd -P`). A symlink anywhere in that chain fails the launch with
its own exit code instead of silently redirecting writes outside the tree.

**Preparation** (`mkdir -p`, `umask 077`) is the only write the shell performs
inside the distribution, it is confined to the validated root, and it never
changes or removes pre-existing content — an existing `dsh-home` keeps its files
and modes.

**Environment delivery.** Variables are exported *inside* the distribution by the
start wrapper, so `~` expands against the Linux home and nothing depends on
`WSLENV` forwarding from Windows. `PATH` is prefixed with the isolated runtime and
the resolved `node`, making resolution deterministic instead of inheriting an
arbitrary shell profile. The wrapper re-validates the root and re-checks the four
managed directories, so it can never launch against a root that changed after
preparation.

**Working directory.** `wsl.exe --cd` is not used: whether it expands a
tilde-prefixed subpath depends on the WSL build, and the shell has to resolve
`~` anyway. The wrapper enters the workspace itself (`cd`), treating `~` as the
isolated workspace when isolation is on, and fails with a distinct message when
the directory is missing or is not a directory. Workspace values with `.`/`..`
segments or empty components are rejected.

**Limits — this is not an OS sandbox.** Isolation covers environment variables,
the npm prefix, caches and temp files. npm lifecycle scripts, `dsh` tools and any
command the WebUI user starts still run with the owner's Linux user permissions;
nothing prevents such a process from writing elsewhere in the distribution. The
guarantee is scoped to what this app itself creates and launches.

### Window and tray state### Window and tray state

Window `show`/`hide` events feed `Supervisor.markHidden()`, so `READY` and
`HIDDEN_IN_TRAY` always reflect what the user sees; closing the window (X) moves
the state to `HIDDEN_IN_TRAY` while supervision continues (health checks slow to
25 s).

The visibility policy is pure (`src/main/core/visibility.ts`) and enforced in the
main process:

- the first successful start honours `openOnLaunch`; afterwards a window the user
  hid is **never** re-shown by a later `READY`;
- the always-on-top splash is activated only when the app window is on screen, so
  a hidden app never pops a window over the desktop during recovery or failure;
- tray Open routes to the overlay when there is nothing loadable yet (`ERROR`,
  `RECOVERING`), otherwise to the window;
- recovery restores the tray state it started from: a hidden app recovers into
  `HIDDEN_IN_TRAY`, not `READY`.

### Reconnection after a restart

`Supervisor.readyGeneration` increments on every successful connect. When the
generation changes the window layer calls `loadBackend(origin, { force: true })`,
which reloads the original WebUI even though the URL is unchanged — the document
behind it belongs to a dead backend session. Navigations are serialized through a
single in-flight promise, so a recovery burst cannot race two loads; no substitute
UI and no injected styles are involved, and DSH session state stays server-side.

## Ownership

A server counts as app-owned only when all of the following hold:

1. a record exists in the app profile with matching preset, distro and port;
2. the recorded Linux PID is alive and its `/proc/<pid>/stat` start time matches
   the recorded value (PID-reuse guard);
3. its command line still contains the `dsh` marker, the `web` profile, our
   `--host 127.0.0.1` and our `--port`.

Port reachability never grants ownership. An occupied port without a verified
record is a collision: the shell fails closed, shows the port and the remedy, and
touches nothing.

Loss handling keeps the ownership data. A recovery first **reclaims** the
app-owned process — verified, `SIGTERM`, then `SIGKILL` — before the port is
probed again, so a hung-but-alive backend can never survive a failed recovery and
an occupied port afterwards is necessarily somebody else's listener (collision).
A process that already died is simply forgotten; a PID whose start time no longer
matches is never signalled.

`SIGKILL` is a last resort and is re-validated twice immediately before it is
sent: PID, `/proc/<pid>/stat` start time and command line must still match the
recorded backend, otherwise the escalation is withheld (PID-reuse protection).
Finally the Windows-side `wsl.exe` launcher handle is closed. No `wsl --shutdown`,
no `taskkill`, no port-wide kills.

## Token handling

The `dsh web:` line is parsed in `src/main/backend/urls.ts` against the fixed
origin. The tokenized URL is consumed by `ses.fetch` in the isolated session
(cookie jar), which answers with the signed session cookie and a redirect to
`./`; the renderer only ever navigates to `http://127.0.0.1:<port>/`. The token
is never written to logs, UI, dialog text or status snapshots — `redactSecrets`
runs on every log line and the token never leaves the module's local scope.

## Window hardening

Backend window: `nodeIntegration:false`, `contextIsolation:true`,
`sandbox:true`, `webSecurity:true`, no preload, `webviewTag:false`, menu bar
hidden, devtools available only to the developer.

- `will-navigate` / `will-redirect`: only the exact configured origin.
- `setWindowOpenHandler`: popups denied; safe public HTTPS links are handed to
  the system browser, loopback/LAN/literal-IP targets are refused.
- Permission handler allowlist: `fullscreen`, `clipboard-sanitized-write` only.
- Downloads are cancelled; `will-attach-webview` is refused.
- Close (X) hides to tray; only the tray Quit path destroys windows.

Splash and settings windows are local `file://` pages with tiny preloads. Every
IPC handler rejects senders whose frame is not a local file.

DevTools are enabled only for unpackaged builds or with
`WSL_WEB_SHELL_DEVTOOLS=1`; packaged production builds keep the debugger closed.

### Diagnostics hygiene

Backend output, exception text and startup URLs are untrusted strings. Every
published status (`message`, `detail`), tray/dialog text and log line passes
through `sanitizeForDisplay()`: ANSI escapes and control characters are removed,
whitespace is normalised, launch tokens are redacted and length is capped. The
log redacts as well, so a token can never reach a screenshot, the clipboard or a
shared diagnostic bundle.

## Configuration

`userData/config.json` (validated on load and on save), `userData/owned-server.json`
(ownership record), `userData/logs/app.log` (redacted, rotated at 2 MB). The app
never writes into the Linux home, the Windows DeepSeek Harness installation,
`app.asar`, user projects or any global runtime.

Backend-affecting settings (distro, port, workspace, executable path) are
snapshotted when a server is brought up, so editing them never silently restarts
or re-points a running backend; the tray "Restart WebUI" applies them.

## Testing

`npm test` (vitest) covers the Electron-free core: startup URL parsing and
redaction, argv construction and path validation, WSL output decoding,
ownership/PID-reuse decisions, port classification and a real loopback socket
probe, lifecycle transitions and backoff, navigation/popup/permission policy,
configuration validation, tray model, and supervisor flows against injected
fakes (ready, collision, foreign listener, cookie rejection, unexpected exit,
retry exhaustion, health recovery, shutdown).

Configuration gained two fields: `isolateEnvironment` (default on) and
`runtimeRoot`. Both require a backend restart, so the tray decision stays
explicit; a settings file written by an older build normalises to the isolated
defaults instead of silently running unisolated.

The launcher scripts are not only string-tested: `tests/isolation.test.ts` runs
them under `/bin/bash` with a throw-away `HOME` and a stub backend, proving that
the environment really reaches the child process, that preparation creates only
the planned directories, and that the single-argument helpers receive their
parameter (a `sh -c` operand lands in `$0`, not `$1`).

`npm run smoke:headless` additionally starts the real built main process under
Xvfb with a sanitised environment (Windows interop removed from `PATH`, throw-away
`HOME`) and asserts that launch reaches a terminal, actionable error instead of
crashing. It never touches a WSL distribution. It caught two launch-blocking
regressions that unit tests cannot see: Electron `session` and `Tray` being
created before `app.whenReady()`.

Not covered by unit tests (needs R02): real `wsl.exe` behaviour, real `dsh`
output, Chromium cookie handling for the loopback origin, packaging runtime,
window/tray rendering on Windows, and the visual result of the refresh-after-
restart path.
