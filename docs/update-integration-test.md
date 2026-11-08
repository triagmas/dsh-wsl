# Update acceptance on an isolated fixture (issue #17)

`tests/update-fixture.test.ts` is the acceptance test for the shared-installation
updater. It is an ordinary unit test — it runs on Linux in the `verify` CI job and
locally with `npx vitest run tests/update-fixture.test.ts` — and it never touches
WSL, a real global prefix, the owner's installation or the network.

## Why a fixture

The updater must change *the installation the app runs* and nothing else. Proving
that on the owner's machine would mean rewriting a real global npm prefix, which
is exactly what the project rules forbid without separate approval. The test
therefore reproduces the whole installation shape in a temporary directory:

```
<tmp>/dsh-wsl-fixture-XXXX/
  .npm-global/                      <- the "installed" DSH prefix
    bin/dsh                         -> symlink npm creates for the package bin
    lib/node_modules/@deepseek-ai/dsh/
  .local/bin/npm                    <- shim npm (see below)
  .profile, .bash_profile           <- PATH with the fixture prefix
  stubs/old|new/*.tgz               <- stub @deepseek-ai/dsh packages
```

The stub packages are minimal but realistic: `package.json` with
`"name": "@deepseek-ai/dsh"`, a `bin` entry and a JS file that prints
`dsh <version>`, so the real npm creates the same symlink layout a real
installation has.

## The npm shim

The scripts install `@deepseek-ai/dsh@<version>` from the registry. In the fixture a
four-line bash shim sits where the scripts look first (`$HOME/.local/bin/npm`) and
does two things:

- `prefix -g` answers with the fixture prefix, so the scripts' prefix-agreement
  check (`npm reports prefix […] instead of […]`) is exercised for real;
- the exact registry spec is rewritten to the matching **local tarball**, so
  `npm install --global --prefix …` genuinely installs, fully offline.

Everything else is the production code path: the same script text, the same
validation, the same version verification, the same rollback.

## What the test asserts

| Assertion | Evidence |
| --- | --- |
| The app and a shell use one executable | `bash -lc 'command -v dsh'` and the app's inspection both resolve `<prefix>/bin/dsh`; `readlink -f` is inside the package directory |
| Provenance is detected | `manager=npm`, `prefix` = fixture prefix, `package` = the package directory, `writable=yes`, `foreign=0`, `source=login-shell` |
| The plan accepts exactly that | `planSharedUpdate()` returns the pre-update state, target version and scope |
| The update changes that installation | `UPDATE_SHARED_SCRIPT` exits `0`; `dsh --version` reports the target; **the realpath is unchanged**; the inspection now reports the new version |
| A login shell sees the update | the script prints `a login shell resolves the updated executable` and the shell still resolves the same path |
| Recovery works | `ROLLBACK_SHARED_SCRIPT` reinstalls the previous exact version and `dsh --version` reports it again |
| Foreign processes are not touched | a process whose command line contains the realpath makes the inspection report `foreign≥1`, the plan refuse with `foreign-process`, and the script exit `78` — the version stays unchanged |
| Non-writable prefixes are refused | a `0555` prefix makes the script refuse (`75`/`76`/`81`) and the installed package is byte-identical afterwards |
| No snapshot, no update (B1) | a read-only app data root makes `PREPARE_BACKUP_SCRIPT` exit `79` and the installation is untouched |
| Symlinked snapshot locations are refused (B1) | an `update` directory that is a symlink exits `79`, and the link target stays empty |
| Incomplete snapshots are refused (B1) | deleting `payload/` makes the update exit `80` with "nothing was changed"; a snapshot from another installation is refused too |
| Offline recovery works (B1) | after a simulated crash (package entry point and manifest removed) with the registry switched off, `ROLLBACK_SHARED_SCRIPT` restores the previous version from the snapshot alone and never calls npm; with the snapshot removed it fails explicitly (`74`) instead of guessing |
| Changed identity is refused (B2) | re-pointing `bin/dsh` at a foreign package, replacing the package directory with a symlink, switching the npm prefix and replacing the package manifest each abort (`81`/`76`) with nothing written |
| Login-shell divergence is a failure (B3) | a shell profile that resolves another `dsh` before the install exits `82`; a shadowing change that happens *during* a successful install exits `84`, restores the previous version and leaves it installed |

## Limits

- The fixture proves the *mechanism*, not the owner's environment: the real
  distribution's `npm prefix -g`, its permissions and its version remain unproven
  until a real run is approved.
- The stub packages are not DeepSeek Harness; the test proves the installation and
  version flow, not the application's own behaviour after an update.
- The Windows CI job covers packaging and relaunch of both Portable and Setup
  builds; it does not run WSL.
