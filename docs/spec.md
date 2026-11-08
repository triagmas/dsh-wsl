# DSH WSL — Product & Architecture Contract

Version: 0.1 / M1. Source of truth: [Issue #1](https://github.com/triagmas/dsh-wsl/issues/1). Status: specification only; **not yet a working application**.

## Purpose

Provide a standalone Windows Electron app, a single native window hosting a backend's **original WebUI** served from a **native existing WSL2 distribution**. DeepSeek Harness via `dsh web` is the first preset. Other local Linux WebUIs may be added as independently reviewed presets; do not attempt to be a browser or implement a second chat interface.

### Topology

```text
Windows taskbar / system tray
 └─ DSH WSL.exe (Electron main process)
    ├─ supervisor: startup, liveness, retry, process ownership
    ├─ tiny local splash: progress, connection/reconnect, actionable error
    └─ sandboxed Chromium BrowserWindow (original unmodified DSH WebUI)
         ↕ verified origin http://127.0.0.1:3080
      native Ubuntu WSL2 / dsh web --host 127.0.0.1 --port 3080 --no-open
         ↳ Linux session state, agents, models, terminal, tools, projects
```

The official Windows DeepSeek Harness Desktop is **not used or modified**. The app must not replace any upstream buttons, hotkeys or composer.

## Defaults and settings

| Setting | Default | Constraints |
| --- | --- | --- |
| Backend preset | DeepSeek Harness | future backends require tested transport and auth adapters |
| WSL distro | Ubuntu | use existing installed distro; do not create/install one |
| Bind host | 127.0.0.1 | immutable loopback-only |
| Local port | 3080 | configurable numeric port after validation; never arbitrary URLs |
| Window Close (X) | Hide to tray | server remains supervised |
| Tray Quit | Graceful complete exit | cleanup only process *owned* by app, never entire WSL |
| Health checks | visible ~10s, hidden ~25s | main-process timer; timings adjustable after measurements |
| Retry policy | bounded exponential backoff | stop with actionable error; avoid duplicate instances |
| Appearance | dark/light by OS | original UI decides its own theme |
| Startup visual | minimal orbital loader | original CSS animation, respects reduced motion |

Settings UI stays separate from the WebUI (tray menu / small app-owned settings panel). User cannot edit navigated URL. Backend profile settings are **not** an arbitrary shell-command textbox shipped enabled by default.

## Lifecycle state machine

`CHECKING → STARTING_WSL → STARTING_WEB → CONNECTING → READY`.

Additional states: `HIDDEN_IN_TRAY` (window hidden, still supervised), `RECOVERING` (when backend is interrupted), `ERROR` (terminal until retry), `QUITTING`. Transitions must be explicit, serialized and idempotent; there must not be multiple concurrent dsh-web starts.

- On application launch, take Electron single-instance lock, read app config, verify distro and prerequisites. If WSL is stopped, start it via `wsl.exe -d Ubuntu --exec ...`.
- If app-owned server is alive, reuse it; otherwise start a new owned Linux server. If fixed port is occupied by an unknown server, fail closed with a clear collision message, **do not silently connect** based on a page title or endpoint content.
- Read `dsh web` startup output: it may print a one-time **token-bearing local URL** for browser login. For installed upstream version, verify exact line/output format before coding. Parse only the expected `http://127.0.0.1:<configured port>` and permitted token path/query. Keep token ephemeral; send only to the isolated Electron browser partition, not logs, errors or crash uploads. Do not assume a fresh `localhost` session is already authorized. Redirect back to same origin is allowed.
- Load the original WebUI, without injecting replacement buttons or styles. Only show local splash prior to readiness and while reconnecting, never fake backend ready state.
- Clicking X hides to tray (never kills WSL/DSH), the background main process continues health checks. Tray click/Open re-shows, performs immediate health check, shows the recovering overlay until backend is ready, and restores the original WebUI.
- Unexpected exit or failed health => attempt controlled restart **of app-owned process** with capped retries and cooldown. If externally managed backend cannot be authenticated as app-owned, display failure and do not terminate/restart it.
- Tray menu: Open, Connection Status, Restart WebUI, Settings, Quit. Restart is allowed only for owned process. Quit ends Electron and gracefully stops **only** app-owned backend if set by policy, never the distro. Persist only app config/browser session under a dedicated app profile.
- Missing WSL, distro, Node or DSH: show steps to install; never fetch binaries or install a private copy silently. DSH WSL runs the `dsh` the distribution already has (issue #17); the in-app update changes exactly that installation, only after an explicit confirmation.

## Security boundaries

- Electron `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`; no preload granting Node/FS/process APIs to backend WebUI, and no disabling security flags to work around WebUI bugs.
- Exact origin allowlist for navigation; deny popup/window.open by default. Support external HTTPS links through system browser only after deliberate policy checks, **not** arbitrary `shell.openExternal` from backend content.
- Verify backend ownership independently from port reachability; local port bind must not expose WebUI to LAN/Internet. Tokenized startup URLs are credentials: no logging, screenshots, clipboard or diagnostic uploads containing secrets.
- Use `spawn` with fixed argument arrays, validate distro/port/profile args. If invoking a shell inside WSL for compatibility, use fixed scripts and safe argument handling; no interpolation of untrusted user text.
- Track owned process IDs and lifecycle, handle WSL spawning process trees safely. No `wsl --shutdown`, mass `Stop-Process`, `taskkill`, or killing unrelated service on port.
- Do **not** change official Windows DSH the installed official Windows Harness application directory, the owner's existing Windows Harness data/profile directory, Windows Desktop profile/plugin configs, global networking settings or user projects.
- Do not automatically download runtime dependencies at first launch. Respect Electron code-signing/installer trust considerations for future release. The software will be public; do not commit token samples, private addresses or identifiable log paths.

## UI / visual direction

Use a minimal **original** local splash inspired by [21st.dev's Orbital Loader](https://21st.dev/@molecule-lab-rushil/components/orbital-loader), not a wholesale dependency-heavy UI kit. A soft animated orbit, neutral dark background, logo + short stage-specific messages. Allow an optional light look and `prefers-reduced-motion`; no fabricated percentage or imitation of Harness's composer. On reconnect, a slight backdrop dim/blur with “Reconnecting…” is enough. Show Retry/Diagnostics when terminally failed. The actual DSH WebUI remains intact.

The main window keeps a thin permanent bottom bar (30–34 px) owned by the app: connection state, distro and port on the left, the running `DSH` version and the latest published GitHub release on the right, and a gear that opens a compact settings popover. It is chrome around the WebUI, not a redesign of it: the remote page lives in its own `WebContentsView` above the bar with no injected markup, styles or scripts, and the version lookup is informational only — the app never updates DSH. Contract and limits: [footer.md](footer.md).

## Testing and deliverables

**R00**: independent Electron/TypeScript scaffold in branch `feat/m1-electron-shell` from clean public repo main; README, lint, TS build, unit tests, Windows GitHub Actions. Validate current DSH Web CLI startup/authorization semantics from primary source and/or local inspection; document uncertainties. No real user-environment execution.

**R01**: app main, WSL supervisor, dynamic authenticated URL bootstrap, strict local navigation, tray, health/retry, splash. Tests: origin/token validation, port conflicts, WSL spawning argument integrity, process ownership, concurrent launch prevention, X→tray vs Quit and recovery. Package Windows x64 EXE; record actual path, SHA-256, tests and added/deleted line counts.

**R02**: **separate explicit owner consent** before any real launch in Ubuntu or modifying existing environment. Test start when WSL stopped, fresh browser auth, real composer, Linux tool execution in dummy project, X→tray persistence, server loss/recovery, tray Quit and no changes to working Windows Desktop/profile. Never test by killing unrelated services.

## Governance

The source repo is `triagmas/dsh-wsl` (public, MIT), a fresh product, **not a migration of old plugin code**. Previous plugin repository `triagmas/dsh-wsl-native` stays intact as history. GitHub = source of truth. Do not merge PR or publish release without owner approval. All code/docs in English; user-facing Pi reports in Russian, with HEAD, changed file and +/− lines, tests and explicit blocked/not-run items.
