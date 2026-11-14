# Manual DeepSeek Harness update (issues #12 and #17)

DSH WSL no longer updates anything itself. When a newer release is published, the
footer pill opens a window that states the installed and the published version and
shows the exact commands the owner runs in a WSL terminal. The app never stops,
starts, installs or writes a package: it reads, reports and copies text.

This is deliberate. An in-app updater had to stop the owner's backend, take a
verified snapshot, drive `npm` and restore on failure — a large amount of code
running with the owner's rights for something a terminal does in three lines. The
smaller promise is easier to audit: **DSH WSL observes your installation and tells
you the truth about it.**

## What the window shows

| Fact | Source |
| --- | --- |
| Installed version | `dsh --version` of the executable the launcher uses |
| Available version | informational GitHub releases lookup (18 h cache) |
| Distribution | the selected WSL distribution |
| Executable | the resolved `dsh` path |
| Install scope | npm/pnpm global prefix and whether it is user or system-wide |

When the installed version is already the published one, the window says so and
shows no command. Clicking **Check again** runs a fresh read-only inspection, so the
owner sees the result of a command they just ran without restarting the app.

## The commands

The plan is built by the pure `buildManualUpdatePlan()` in
`src/main/core/manual-update.ts`. The browser process never executes it.

| Situation | Commands |
| --- | --- |
| the owner's systemd **system** unit runs the attached backend | `sudo systemctl stop <unit>`, `<manager> install -g @deepseek-ai/dsh@<version>`, `sudo systemctl start <unit>` |
| a **user** unit runs it | `systemctl --user stop <unit>`, install, `systemctl --user start <unit>` |
| the attached backend was started by hand | install only, plus "stop the backend by hand before running this command" |
| the backend belongs to DSH WSL | `kill <pid>` then install — quitting the app deliberately leaves that backend running |
| no backend is running | install only |
| the manager is pnpm | `pnpm add -g @deepseek-ai/dsh@<version>` |
| the manager, installed version or target is unknown | no command, only an explanation |
| the published version could not be checked | no command: the cached target is not presented as current |

`npm install -g` is bound to the inspected installation (`"<npmPath>" install -g --prefix "<prefix>"`)
whenever both are known and safe to quote, because a bare command installs into
whatever prefix the owner's own terminal resolves. When the prefix is not writable
by the owner, the window says the install needs root.

`npm install -g` and `pnpm add -g` are the only install forms. The target must be an
exact version: ranges, tags and anything a shell could interpret are refused. A unit
name is shown only when it is a valid `.service` name discovered read-only from
`/proc/<pid>/cgroup`; the app never invents one, never asks for a password and never
runs `sudo` or `systemctl`.

The installed version means what the inspected executable reports, not a cached
status field. A version that cannot be read is reported as unknown, and no command
is shown.

## What is still read from the distribution

The inspection script in `src/main/wsl/inspect.ts` is launched as
`wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>` with validated positional
operands. It only reads:

1. the executable a login shell resolves, the minimal `--exec` path, or the
   configured path;
2. `readlink -f`, the package directory and `package.json` identity;
3. `npm prefix -g` / `pnpm root -g` and whether the prefix is writable;
4. `/proc` for other processes running from the same real path;
5. the versions reported by the app executable and by the login-shell executable.

The systemd unit is discovered separately, also read-only, from the attached
backend's cgroup. Failure to identify a unit is not an error: the window then shows
the install line and asks the owner to stop the backend by hand.

## Windows and IPC

| Surface | File | Notes |
| --- | --- | --- |
| update window | `src/update/confirm.html` | 640×620, modal, non-resizable, `sandbox: true`, CSP `default-src 'none'` |
| bridge | `src/preload/update.ts` | `probe`, `recheck`, `close` only |

Channels: `footer:open-update`, `update:probe`, `update:recheck`, `update:close`.
All go through the existing trusted-sender guard. The page performs no network I/O
and has no password field.

Per-line **Copy** and **Copy all** use the clipboard API with a selection-based
fallback; each copied line is announced through an `aria-live` region.

## Verification

- `tests/manual-update.test.ts` — exact-version guard, manager-specific install line,
  stop/install/start order, every backend and scope branch, invalid/unknown refusal,
  installed-state transition.
- `tests/inspect.test.ts` — argument construction and the read-only nature of the
  inspection script.
- `tests/managed.test.ts` — cgroup parsing and the read-only unit probe.
- `tests/dsh-locate.test.ts` — provenance report parsing and scope wording.
- `tests/r09.test.ts` — the app never spawns an installer.

A real update of the owner's global WSL installation is a manual step: these tests
only cover the instructions the app produces.
