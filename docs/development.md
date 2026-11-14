# Development

```sh
npm ci
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm test              # vitest (unit tests only, no WSL/Electron needed)
npm run build         # esbuild -> dist/ (main, preloads, local pages, icons)
npm start             # build + run Electron on the current platform
npm run verify        # typecheck + lint + tests + build
```

## Checks that need a display or a desktop session

```sh
npm run smoke:headless   # Linux/WSL: launch the built app under Xvfb with a
                         # sanitised PATH/HOME; must reach a clean terminal error
npm run chrome:smoke     # Linux/WSL: render the footer, settings popover and the
                         # update windows with fixed test data and assert what
                         # they show (no WSL)
npm run screenshots      # same render, writes docs/media/*.png
npm run composition:smoke  # real BrowserWindow + WebContentsView composition
                         # against a local test server: bar, bounds, resize,
                         # session, cold-start attach order
npm run paint:probe      # real screen pixels of a composed window: the remote
                         # WebUI must be visible above the bar (needs a display;
                         # CI uses xvfb on Linux and a desktop session on Windows)
```

## Packaging

See [packaging.md](packaging.md) for the two Windows artifacts, the installer
behaviour and the CI pipeline:

```sh
npm run dist           # both packages
npm run dist:portable  # portable EXE only
npm run dist:setup     # NSIS Setup EXE only
npm run dist:dir       # unpacked app
```

## Documentation check

`npm run docs:check` verifies that every relative link and image in `README.md`,
`README.ru.md` and `docs/**/*.md` exists (it runs in CI as part of `verify`).

## Project layout

```
src/main/          Electron main process
  core/            Electron-free logic: supervisor, ownership, isolation, manual
                   update plan, config, branding, diagnostics
  electron/        windows, tray, config store, web client (Electron-specific)
  wsl/             wsl.exe gateway, argument validation, inspection scripts
  backend/         DeepSeek Harness specifics (URLs, versions, GitHub releases)
src/preload/       contextIsolation bridges (sandboxed)
src/chrome/        app-owned window: 32 px footer bar
src/popover/       settings popover
src/settings/      standalone settings window
src/splash/        orbital startup/recovery screen
src/update/        update confirmation and terminal windows
src/shared/        types shared between processes
scripts/           build, packaging probes, render smoke tests, docs check
tests/             vitest suites (all Electron-free or source-invariant)
docs/              architecture, spec, packaging, update, evidence
```

## Rules that must stay true

- Core logic stays Electron-free and is injected through `SupervisorDeps`, so it is
  testable without a desktop.
- The WebUI is the untouched upstream page in a sandboxed `WebContentsView`
  (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`); no Node API is exposed to it and no arbitrary URL is loaded.
- The supervisor only stops processes it owns (PID + start time + command line); an
  unknown listener fails closed.
- Tokens are validated before loading and never logged.
- The profile directory name and the Windows `appId` are user data and installer
  identity: they do not change with a rename.
