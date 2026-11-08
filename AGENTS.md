# Agent development contract (Pi and other coding assistants)

**Read first:** [docs/spec.md](docs/spec.md) and [Issue #1](https://github.com/triagmas/dsh-wsl/issues/1).

## Objective

Build a **small standalone Windows Electron application for WSL WebUIs**. The first backend is the **native Ubuntu WSL2 `dsh web`** (official DeepSeek Harness web app). Electron hosts **the original backend WebUI**: do not draw a duplicate composer, custom conversation UI, sidebar, buttons, or hotkeys. No Cordis Desktop plugin and no editing upstream DeepSeek Harness Desktop.

## Repo/workflow

- Source of truth: `triagmas/dsh-wsl`. Implement in `feat/m1-electron-shell`, base `main`.
- Current main is a fresh MIT repo. **Do not import old `dsh-wsl-native` internals**. Do not modify `triagmas/dsh-wsl-native`, its closed PRs, or this repo's `main` except via a separately approved merge.
- R00/R01 only: implement, run non-destructive build/tests, report. **No real execution inside owner's Ubuntu WSL, installation/upgrade, process killing or network/package fetching beyond normal isolated development needs without explicit owner approval**. Do not assume personal Windows paths are available from GitHub.
- No merge, release, repository rename or tag without owner approval. Keep changes in reasonably sized macro packages, not dozens of micro-PRs.
- All source, code comments, docs and GitHub summaries in English. All owner-facing reports **in Russian**.
- Provide exact HEAD, changed file counts and +added/-deleted lines, verification/CI, packager output, SHA-256 where generated, blocked items.

## Must-have engineering rules

1. Native Electron window, WSL service supervisor (main process), isolated browser session, original WebUI. No URL bar, tabs or arbitrary URL.
2. State machine in `docs/spec.md` including Close→tray, tray Open/Status/Restart/Settings/Quit, health/reconnect overlay, bounded retry, owned process shutdown only.
3. Use fixed loopback origin and **validate the DSH tokenized startup URL** before loading. Never leak token in logs/UI/error messages.
4. Electron web contents: `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, no Node API exposed to backend GUI, navigation and popup restrictions, no unsafe shellOpenExternal.
5. Validate distro, port and backend preset, safe spawn argument arrays; single-instance and launch mutex. Never adopt an unknown port or kill unrelated WSL services. Do not use `wsl --shutdown`.
6. No modification of user's official Windows DeepSeek Harness installation, `app.asar`, Desktop userData/profile, user projects, system proxy, network exposure or existing distros. Never silently install DSH/Node.
7. Original lightweight local splash inspired by Orbital Loader, with reduced-motion fallback and accurate startup stages, and terminal error/retry.
8. Tests/CI (Windows build + unit tests). EXE artifact and real GUI/WSL acceptance need separate owner approval when appropriate. Do not claim Windows runtime test if only static CI succeeded.

## R00 implementation

- Confirm upstream `dsh web --host 127.0.0.1 --port ... --no-open`, startup URL/token output, cookie session and app readiness behavior for the installed/target version. Record verified sources and any unknowns.
- Build clean Electron/TypeScript skeleton with `main`, isolated splash UI, backend supervisor interfaces, tests for token URL handling, WSL launch validation, navigation and ownership decisions; add test/build pipelines and Windows packaging scripts.
- Keep server execution/mock tests isolated and side-effect-free until real owner approval.

## R01 implementation

- Implement default DeepSeek profile launching and supervising WSL Web process, session auth bootstrap, tray lifetime, reconnection/error states.
- Produce an EXE and report. STOP for owner-approved R02 real smoke. Never conflate source-level green checks with actual WSL Desktop integration PASS.

When blocked, report exact limitation and the smallest safe next action. Avoid pushing speculative workarounds.
