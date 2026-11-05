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

## Ownership

A server counts as app-owned only when all of the following hold:

1. a record exists in the app profile with matching preset, distro and port;
2. the recorded Linux PID is alive and its `/proc/<pid>/stat` start time matches
   the recorded value (PID-reuse guard);
3. its command line still contains the `dsh` marker, the `web` profile, our
   `--host 127.0.0.1` and our `--port`.

Port reachability never grants ownership. An occupied port without a verified
record is a collision: the shell fails closed, shows the port and the remedy, and
touches nothing. Graceful shutdown sends `SIGTERM` to the verified PID, waits,
then `SIGKILL` only if it is still alive, and finally closes the Windows-side
`wsl.exe` launcher. No `wsl --shutdown`, no `taskkill`, no port-wide kills.

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

Not covered by unit tests (needs R02): real `wsl.exe` behaviour, real `dsh`
output, Chromium cookie handling for the loopback origin, packaging runtime,
window/tray rendering on Windows.
