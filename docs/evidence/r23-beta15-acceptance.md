# R23 — Windows host acceptance for v0.1.0-beta.15

Acceptance record for the first prerelease that contains the recovery fix of issue #29 and
the console leftovers of beta.14.

**Status: not run.** Every result field below is empty on purpose. Do not fill a field with
an expectation, and never copy an expectation into `Result`. If a step cannot be run (for
example no newer `dsh` has been published yet), record `blocked` with the reason — a blocked
step is not a failure.

## Target

| Field | Value |
| --- | --- |
| Release | `v0.1.0-beta.15` (fill after publishing) |
| Commit | `____` |
| Portable SHA-256 | `____` |
| Setup SHA-256 | `____` |

## Environment

| Field | Value |
| --- | --- |
| Date | `____` |
| Windows build | `____` |
| WSL distribution and version | `____` |
| Installed DSH version before the run | `____` |
| Package used (Portable / Setup) | `____` |

## Checklist

Expected behaviour below is derived from reading the code; it still needs confirming on the
host. Each step has its own result fields.

### 1. Full successful update with an attached systemd unit

Precondition: `dsh-web.service` is active, a **newer** `dsh` is published (otherwise the
pill is not offered and this step is `blocked`, not failed).

Expected: the console window opens, `sudo` asks for the password exactly once and before
anything is stopped, the log streams, every command is echoed, the installed version is new
afterwards, the app reaches `READY`, and no stray console or backend window is left behind.

- Result: `____`
- Date: `____`
- Notes: `____`

### 2. Wrong sudo password

Expected: the password prompt is refused, **nothing was stopped**, the window reports the
failure, and `systemctl is-active dsh-web.service` still says `active`.

- Result: `____`
- Date: `____`
- Notes: `____`

### 3. Ctrl-C in the console during the install

Expected: the script exits through its trap and runs the `start` line again, so the service
is up afterwards (the password timestamp from the preflight is still valid).

- Result: `____`
- Date: `____`
- Notes: `____`

### 4. Console window closed during the install — risky, manual, read first

**This step can leave your backend down.** Closing a Windows console may kill the `wsl.exe`
client before the script's `EXIT` trap runs; in that case no recovery line is printed and the
unit stays stopped. Do not run it before you have a WSL terminal open beside the app.

Before the run: note `systemctl is-active dsh-web.service` and keep
`sudo systemctl start dsh-web.service` ready to paste. If the app then serves on a fallback
port, the unit is down and the app is filling in.

Expected: the app keeps serving on a fallback port while the unit is down, and after
`sudo systemctl start dsh-web.service` the port is handed back within about one health tick,
with no `EADDRINUSE` in `app.log`.

- Result: `____`
- Date: `____`
- Notes: `____`
- Service state right after closing the console: `____`
- Port handed back (yes / no / not applicable): `____`

### 5. App-owned backend (no unit)

Precondition: the unit is stopped or not configured, so the app starts its own backend.

Expected: the update runs, the app restarts its own backend, and the WebUI loads on the fixed
loopback origin.

- Result: `____`
- Date: `____`
- Notes: `____`

### 6. Killed app-owned backend while WSL is slow — optional, owner only

Expected after issue #29: instead of a permanent splash the app shows the terminal error with
**Retry**, a single concise log line, and Retry reaches `READY` once WSL answers again.

- Result: `____`
- Date: `____`
- Notes: `____`

## Acceptance

Pass requires steps 1–5 (step 6 is optional) on the owner's Windows 11 + Ubuntu WSL2 machine,
with a short note per step and `app.log` attached on failure. A recorded failure with its log
is more useful than a pass without evidence: CI already covers what CI can cover, and it
cannot run WSL or a Windows desktop.
