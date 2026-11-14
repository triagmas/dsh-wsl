# Diagnostics and support

When a window disappears or the app exits, the log distinguishes the cause without
recording content.

## Where the files are

| What | Path |
|---|---|
| Profile (config, logs, caches) | `%APPDATA%\wsl-web-shell` |
| Log | `%APPDATA%\wsl-web-shell\logs\app.log` |
| Settings | `%APPDATA%\wsl-web-shell\config.json` |
| Owned-backend registry | `%APPDATA%\wsl-web-shell\owned-server.json` |
| Version cache | `%APPDATA%\wsl-web-shell\versions-cache.json` |
| Isolated WSL runtime | `~/.local/share/wsl-web-shell` inside the distribution |

The profile directory keeps its original name after the rename to **DSH WSL** on
purpose: it holds user data and must survive upgrades. The settings popover and the
splash screen both offer "Open log folder" / "Open profile folder".

## What the log records

- `window <surface> <event>` lines with `visible/focused/quitting/session-ending`
  flags for every window event that can hide a surface.
- A `previous session: …` line on start-up that reports whether the last run ended
  through the app's own quit path (a missing `shutdown complete` marker means the
  process was killed or crashed natively).
- Fatal-error messages with the error name and message only, no stack.
- Electron child-process failures (`render-process-gone`, `child-process-gone`).
- Supervisor decisions: ownership checks, restart attempts, recovery results.

## What is never recorded

Launch tokens, cookies, prompt or workspace content, and local user directories
(they are redacted). Logs are plain text and can be attached to a bug report.

## When something looks wrong

1. Check the status line in the footer bar: `Connected` means the app's own backend
   is serving the WebUI; `Reconnecting`/`Failed` means the supervisor is retrying or
   gave up (bounded retries).
2. If the splash shows an error, read the message: it names the missing prerequisite
   (WSL distribution, `dsh`, missing runtime) and offers Retry.
3. `Port … is already in use by a service this app does not own` is a deliberate
   fail-closed decision: DSH WSL never adopts or kills a backend it did not start.
   Choose another port in the settings popover.
4. For an update, open the footer pill: the window shows the read-only inspection
   result and the commands to run yourself. `Check again` repeats the inspection.

See [architecture.md](architecture.md) for the state machine and
[update.md](update.md) for the manual update instructions.
