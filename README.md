# WSL Web Shell

**Open-source Windows desktop wrapper for local WSL WebUIs.**

Launch a small Electron application on Windows, automatically start a supported WebUI backend inside your **existing WSL2 distro**, and use the **original browser-based interface** in a standalone desktop window — without browser tabs or an address bar.

**Project status: design / implementation in progress. There is no working EXE or release yet.**

## First supported backend: DeepSeek Harness

- Native `dsh web` runs **inside Ubuntu WSL2**; agents, models, tools, sessions and project files stay in Linux.
- Electron's bundled Chromium displays the **unchanged official WebUI**, including its real chat composer. No replica and no modified official Windows Desktop.
- Default local endpoint: `127.0.0.1:3080` (port configurable in app settings, no arbitrary navigation).
- Start on demand, supervisor/health checks, hide window to tray on X, reopen with auto-reconnect if needed, Quit via tray to exit.
- Lightweight orbital startup/recovery screen; no fake progress percentages.
- Original WebUI auth bootstrap is handled privately. Tokens are never logged or displayed.

Planned later: other trusted WSL WebUI backend presets. **Not** a general-purpose browser, reverse proxy or GUI redesign.

## Development

See [the complete contract](docs/spec.md), [M1 issue](https://github.com/triagmas/wsl-web-shell/issues/1), and [agent guidance](AGENTS.md).

- Development branch: `feat/m1-electron-shell`. No merge into `main` before explicit owner approval.
- Planned stack: Electron + TypeScript, Node for Windows build, native WSL2 on the host, no VM.
- A packaged EXE, CI and real smoke evidence are acceptance requirements; none is claimed to exist yet.
- Licensed MIT. No DeepSeek model weights or official Windows Desktop binaries are redistributed.

## Security and privacy

WebUI server must bind to `127.0.0.1` only; never load an unknown local service on the configured port. Electron must sandbox remote content and restrict navigation. No silent installs, no touching the official Windows DeepSeek Harness installation, profiles or plugins. Existing WSL distributions and Linux projects must not be deleted or shut down.

The earlier `triagmas/dsh-wsl-native` plugin concept is unrelated to this product and remains preserved separately as historical work.
