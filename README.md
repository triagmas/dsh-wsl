<p align="center"><img src="docs/media/logo.png" width="104" alt="DSH WSL logo"></p>

<h1 align="center">DSH WSL</h1>

<p align="center"><b>The original DeepSeek Harness WebUI in a real Windows window, running on your own WSL2.</b></p>

<p align="center"><b>English</b> · <a href="README.ru.md">Русский</a></p>

<p align="center">
  <a href="https://github.com/triagmas/wsl-web-shell/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/triagmas/wsl-web-shell/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/triagmas/wsl-web-shell/releases"><img alt="Release" src="https://img.shields.io/github/v/release/triagmas/wsl-web-shell?include_prereleases&label=release"></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0078D6">
  <img alt="Electron" src="https://img.shields.io/badge/electron-45.2.3-2B2E3A">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/triagmas/wsl-web-shell?label=license"></a>
</p>

![DSH WSL showing the original DeepSeek Harness WebUI with the app-owned footer bar](docs/media/hero.png)

<p align="center">
  <a href="https://github.com/triagmas/wsl-web-shell/releases"><b>⬇ Download for Windows (x64)</b></a>
</p>

DSH WSL is a small Electron shell for WebUIs that run inside WSL2. The first backend
is the native **DeepSeek Harness** (`dsh web`): DSH WSL starts it in your existing
distribution and displays the **untouched official WebUI** — the same interface with
the same capabilities — in a desktop window without browser tabs or an address bar.
No replica UI, no patched upstream build, no duplicated chat interface.

DSH WSL runs **your existing `dsh`** — the same executable an ordinary `dsh web` in a
WSL terminal starts — and keeps its **data** in its own profile
(`~/.local/share/wsl-web-shell`, with its own `DSH_HOME`), so sessions, projects and
credentials of the official Windows DeepSeek Harness are never touched. Because that
`DSH_HOME` is separate, sessions you created through the app are not shared with a
`dsh web` you start in a terminal. Isolation can be switched off in the settings to use
your normal `~/.dsh` data as well.

> **Release status.** The newest published prerelease is
> [`v0.1.0-beta.1`](https://github.com/triagmas/wsl-web-shell/releases/tag/v0.1.0-beta.1).
> It predates the rename, so it ships a single portable EXE under the old
> `WSL-Web-Shell-…` name — no Setup EXE. The **DSH WSL Portable + Setup** pair with
> `SHA256SUMS.txt` is **not published yet**; Windows CI builds it as the
> `dsh-wsl-windows-x64` artifact of every successful run.

## What you get

**Your own WSL, your own data.** Agents, models, tools and project files stay inside
your Linux distribution. DSH WSL never silently changes WSL, Node.js or a globally
installed `dsh`, and it never touches the official Windows DeepSeek Harness installation
or your projects. The one thing it changes is **your DeepSeek Harness installation in
WSL**, and only when you press Update in the app: it then runs
`npm install -g @deepseek-ai/dsh@<version>` into the prefix that installation already
uses (with a pre-check of the path, provenance, manager, permissions and running
processes, and an automatic restore of the previous version if anything fails).

**A window that behaves like an app.**

<p align="center"><img src="docs/media/tray-menu.png" width="300" alt="The tray menu: Focus window, Status, Restart WebUI, Settings, Quit"></p>

Closing the window keeps the app in the tray: *Focus window*, live *Status*,
*Restart WebUI*, *Settings*, *Quit*. The backend is supervised — if it dies, DSH WSL
restarts it with bounded retries and shows an honest reconnecting state instead of a
blank page.

**A thin status bar, never a second UI.** The app-owned 32 px bar shows the live
connection state, the running DSH version and the latest GitHub release. The gear
opens a compact settings popover (distribution, port, isolation, workspace) — the
WebUI itself is never modified.

| Footer bar | Settings popover |
|---|---|
| ![Footer bar](docs/media/footer-bar.png) | ![Settings popover](docs/media/footer-settings.png) |

**One-click DeepSeek Harness update.** When a newer published release exists, the bar
offers it. The exact version is staged next to the running runtime, the app-owned
backend is stopped only for the swap, the previous installation is kept for rollback,
and the new version is reported only after it actually served the WebUI. An
interrupted swap is repaired on the next start.

![Update confirmation](docs/media/update-confirm.png)

## Portable or Setup

Both packages are built from the same commit and behave the same; pick how you want
the app to live on your machine.

| | **Portable** | **Setup** |
|---|---|---|
| File | `DSH-WSL-<version>-x64-Portable.exe` | `DSH-WSL-<version>-x64-Setup.exe` |
| Installation | none — double-click to run | normal Windows setup wizard |
| Admin rights | none | none (per-user) |
| Shortcuts | none | Start-menu entry, optional desktop shortcut |
| Uninstall | delete the EXE | Installed apps → *DSH WSL* → Uninstall |

Both share the same profile (`%APPDATA%\wsl-web-shell`) and the same isolated WSL
runtime, so settings and the installed DSH version are the same whichever you start.
Details, installer behaviour and CI checks: [docs/packaging.md](docs/packaging.md).

## Quick start

**You need:** Windows 10/11 x64 with WSL2, an existing distribution (default preset
`Ubuntu`) and the DeepSeek Harness CLI `dsh` installed **by you** inside it (for example
`npm install -g @deepseek-ai/dsh`). DSH WSL never installs a copy of its own.

1. Open the [releases page](https://github.com/triagmas/wsl-web-shell/releases) and
   download `DSH-WSL-<version>-x64-Portable.exe` (no install) or
   `DSH-WSL-<version>-x64-Setup.exe`, then verify it against `SHA256SUMS.txt`. Until
   that release is published, both files are available in the `dsh-wsl-windows-x64`
   artifact of the latest successful Windows CI run. The binaries are unsigned, so
   SmartScreen may warn about an unknown publisher.
2. Start DSH WSL. The orbital splash shows the real startup stages: WSL check,
   runtime resolution, backend start, token exchange.
3. The official WebUI appears as soon as the backend is ready. Change the
   distribution, port or isolation mode from the gear if needed.
4. When a new DeepSeek Harness release is published, use the pill in the status bar;
   DSH WSL updates your WSL installation after a confirmation that names the executable
   and the npm prefix, verifies the new version and restarts itself.

## Documentation

| | |
|---|---|
| [Packaging: Portable and Setup](docs/packaging.md) | artifacts, installer, CI, relaunch targets |
| [Architecture](docs/architecture.md) | process model, supervisor, window composition |
| [Specification](docs/spec.md) | state machine, tray lifecycle, security rules |
| [Footer bar and settings](docs/footer.md) | the app-owned chrome |
| [One-click runtime update](docs/update.md) | transaction, journal, rollback |
| [Upstream contract](docs/upstream-dsh-web.md) | how `dsh web` is started and verified |
| [Diagnostics and support](docs/diagnostics.md) | logs, profile, failure states |
| [Development](docs/development.md) | commands, tests, layout |
| [Evidence](docs/evidence/r02.md) | real acceptance runs with artifact and SHA-256 |

## Verification

CI runs typecheck, lint, unit tests (source-invariant and Electron-free logic), render
smoke tests of the app-owned surfaces, a real-screen paint probe and the Windows
packaging job that installs, relaunches and uninstalls both variants. Real acceptance
runs on a live Windows 11 + Ubuntu WSL2 machine are recorded in
[docs/evidence/r02.md](docs/evidence/r02.md), [docs/evidence/r09.md](docs/evidence/r09.md)
and [docs/evidence/r091.md](docs/evidence/r091.md). Source-level green checks are never
presented as a substitute for those runs.

## License

MIT — see [LICENSE](LICENSE). No DeepSeek model weights and no official Windows
desktop binaries are redistributed.
