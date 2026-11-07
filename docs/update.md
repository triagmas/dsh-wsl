# One-click update (issue #12)

The footer bar can install the exact published `@deepseek-ai/dsh` version into the
isolated runtime the app is already using. Everything happens inside the current
WSL distribution, below the app's own runtime root; the global installation, the
official Windows DeepSeek Harness and the user's projects are never touched.

```
footer pill (only while an update exists)
   -> confirmation window  (facts + Update/Cancel)
   -> terminal window      (streamed updater output, Close only when finished)
   -> app relaunches itself and starts the new version
```

## When the offer appears

`VersionSnapshot.updateAvailable` (already produced by the informational GitHub
lookup, 18 h cache) decides it. The pill with the circular arrow is `hidden`
whenever `updateAvailable` is false, so the bar never shows an action for a
version that does not exist. The bar stays 32 px tall and unchanged otherwise.

## Guards (`src/main/core/update.ts`)

`planUpdate()` is pure and rejects, before anything runs:

| Reason | Condition |
| --- | --- |
| `invalid-version` | target is not an exact release (`^0.2.2`, `latest`, `…; rm -rf /`) |
| `same-or-older` | `compareSemver(target, installed) <= 0` |
| `unknown-installed` | `dsh --version` did not report a parsable version |
| `global-installation` | `isolateEnvironment` is off — the app would replace a global DSH |
| `custom-executable` | a custom `dshPath` is pinned in Settings |
| `unsafe-root` | `runtimeRoot` is not a dedicated subtree (`~`, `/`, `.`) |
| `foreign-runtime` | the executable in use is not `<root>/runtime/bin/dsh` |

`isInsideIsolatedRuntime()` matches `~/.local/...` as a path suffix as well as an
absolute prefix, because the config stores a tilde while WSL reports
`/home/<user>/…`.

## The updater script (`src/main/wsl/update-args.ts`)

Both steps run through `wsl.exe -d <distro> --exec /bin/sh -c <script> <args…>`
with every operand validated (`isExactVersion`, `isValidIsolationRoot`,
`isValidRuntimeBinary`), never through an interpolated command string.

1. **npm lookup** (`NPM_VIEW_SCRIPT`, read-only): resolves npm with the same
   `PATH` the backend uses and reports `<marker><npm path>`, then
   `npm view @deepseek-ai/dsh@<version> version`. A version npm does not publish
   stops the run before any install.
2. **install** (`UPDATE_SCRIPT`):
   - `npm install --global --prefix <root>/update/stage-<ts> --cache <root>/cache/npm @deepseek-ai/dsh@<version>`;
   - the staged `bin/dsh --version` must report the target version (`exit 71`);
   - `runtime` → `update/previous-<ts>`, `stage-<ts>` → `runtime`;
   - the activated `runtime/bin/dsh --version` is verified again; on failure the
     previous tree is moved back and the stage removed (`exit 72`);
   - exactly one `previous-*` is kept (the rollback copy), older ones are pruned;
   - the stage directory is always removed on the way out.

The script never writes outside `<root>` and never installs globally.

## Restart

On `phase: 'done'` the main process takes the same graceful path as Quit
(owned backend stopped, windows destroyed, `shutdown complete` written) and then
relaunches the portable executable — `PORTABLE_EXECUTABLE_FILE` when present, since
a portable build runs from a temporary extraction directory. A failed run leaves
the current installation in place and the app untouched; the terminal window stays
open with the error and the rollback path.

## Windows and IPC

| Surface | File | Notes |
| --- | --- | --- |
| confirmation | `src/update/confirm.html` | 560×460, modal, `sandbox: true`, CSP `default-src 'none'` |
| terminal | `src/update/progress.html` | 720×520, resizable, `aria-live` pre, text via `textContent` |
| bridge | `src/preload/update.ts` | `probe/start/state/onState/close` only |

Channels: `footer:open-update`, `update:probe`, `update:start`, `update:state`,
`update:close` (main) and the `update:state` event (renderer). All are registered
through the existing `isTrustedSender` guard. The renderer never performs network
I/O: it only renders state pushed by the main process.

## Verification

- `tests/update.test.ts` — guards, terminal buffer, phase model, runner order and
  failure paths (28 tests).
- `tests/wsl-update-args.test.ts` — argument construction/validation plus a real
  `/bin/sh` end-to-end run of the shipped `UPDATE_SCRIPT` in a throwaway
  directory with a fake npm: success, npm failure (`exit 7`) and a
  wrong-version stage (`exit 71`, runtime untouched) (8 tests).
- `npm run chrome:smoke` — renders the pill, the confirmation window and the
  terminal window with their shipped preloads and asserts 34 behaviours.
- `npm run screenshots` — writes `docs/media/update-confirm.png` and
  `docs/media/update-terminal.png`.

All of this is isolated: no test starts WSL, npm, or the owner's desktop.
A real update on the owner's machine is a separate, explicitly approved step.
