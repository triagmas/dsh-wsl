# WSL Web Shell

**Open-source Windows desktop wrapper for local WSL WebUIs.**

Launch a small Electron application on Windows, automatically start a supported WebUI backend inside your **existing WSL2 distro**, and use the **original browser-based interface** in a standalone desktop window — without browser tabs or an address bar.

**Project status: M1 implementation in progress.** `R00` (scaffold, tests, CI, upstream verification) and `R01` (launcher, supervisor, tray, recovery, Windows EXE) are implemented in `feat/m1-electron-shell`. `R02` — the real run against a live Ubuntu + DeepSeek Harness installation — is **not done yet** and requires explicit owner approval. No release exists.

## First supported backend: DeepSeek Harness

- Native `dsh web` runs **inside Ubuntu WSL2**; agents, models, tools, sessions and project files stay in Linux.
- Electron's bundled Chromium displays the **unchanged official WebUI**, including its real chat composer. No replica and no modified official Windows Desktop.
- Default local endpoint: `127.0.0.1:3080` (port configurable in app settings, no arbitrary navigation).
- Start on demand, supervisor/health checks, hide window to tray on X, reopen with auto-reconnect if needed, Quit via tray to exit.
- Lightweight orbital startup/recovery screen; no fake progress percentages.
- Original WebUI auth bootstrap is handled privately: the tokenized startup URL is exchanged for a session cookie in the main process, so the token never reaches the window, the history or the logs.

Planned later: other trusted WSL WebUI backend presets. **Not** a general-purpose browser, reverse proxy or GUI redesign.

## How it runs

```text
WSL Web Shell.exe
 └─ supervisor: start distro → resolve dsh → start `dsh web` → read startup URL → cookie → health
     ├─ local splash / reconnect overlay (orbital loader, reduced-motion aware)
     └─ sandboxed window with the original WebUI at http://127.0.0.1:3080
```

Lifecycle: `CHECKING → STARTING_WSL → STARTING_WEB → CONNECTING → READY ↔ HIDDEN_IN_TRAY`,
with `RECOVERING`, `ERROR`, `QUITTING`. Closing the window hides it to the tray and
the state follows; a later successful start never re-opens a window you closed.
Recovery reloads the original WebUI, reclaims only a verified app-owned backend and
re-checks PID identity before any forced kill. Details:
[docs/architecture.md](docs/architecture.md).

## Requirements

- Windows 10/11 with WSL2 and an existing distribution (default preset: `Ubuntu`).
- DeepSeek Harness CLI installed **by you** inside that distribution (`dsh`).
- The app never installs or upgrades Node, `dsh`, WSL or distributions. Missing
  prerequisites produce an actionable error instead.

## Development

```sh
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest (unit tests only, no WSL/Electron needed)
npm run build         # esbuild -> dist/ (main, preloads, local pages, icons)
npm start             # build + run Electron on the current platform
npm run smoke:headless  # Linux/WSL: launch the built app under Xvfb with a
                        # sanitised PATH/HOME; must reach a clean terminal error
```

Windows packaging (x64, portable EXE):

```sh
npm run dist          # release/WSL-Web-Shell-<version>-x64.exe
npm run dist:dir      # unpacked app for inspection
```

Packaging cross-builds from Linux/WSL as well; the executable is unsigned.
Code-signing and an installer are future release work.

## Report / verification format

Every implementation report includes: exact HEAD, changed file counts with
`+added/-deleted` lines, test and CI evidence, packager output path, SHA-256 of
the artifact, and explicit "not run / blocked" items. Source-level green checks
are never presented as a real Windows/WSL acceptance PASS.

## Security and privacy

- Backend binds to `127.0.0.1` only; the app refuses to load an unknown listener
  on the configured port and never kills processes it cannot prove it started.
- Electron renders remote content sandboxed: no Node integration, context
  isolation on, exact-origin navigation allowlist, popups denied, tiny
  permission allowlist, downloads blocked.
- No silent installs, no touching the official Windows DeepSeek Harness
  installation, profiles or plugins, no `wsl --shutdown`, no system proxy changes.
- Existing WSL distributions and Linux projects are never deleted or shut down.
- Local profile only: `config.json`, the ownership record, the redacted log and
  the isolated browser session live in the app's own `userData`.

## Documentation

- [Product & architecture contract](docs/spec.md)
- [Architecture / implementation notes](docs/architecture.md)
- [Upstream `dsh web` contract and unknowns](docs/upstream-dsh-web.md)
- [M1 issue](https://github.com/triagmas/wsl-web-shell/issues/1) and [agent guidance](AGENTS.md)

A packaged EXE, CI and real smoke evidence are acceptance requirements. CI covers
typecheck, lint, unit tests and the Windows package build; **real GUI/WSL
acceptance is not claimed yet.**

Licensed MIT. No DeepSeek model weights or official Windows Desktop binaries are redistributed.
