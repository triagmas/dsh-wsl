# Packaging: Portable and Setup

DSH WSL ships **two Windows x64 packages built from the same commit**. They behave
identically at runtime; they differ only in how the app is installed and where its
files live.

| | `DSH-WSL-<version>-x64-Portable.exe` | `DSH-WSL-<version>-x64-Setup.exe` |
|---|---|---|
| Installation | none — double-click to run | ordinary Windows setup wizard |
| Admin rights | none | none (per-user install by default) |
| Install location | temporary folder, re-extracted on every start | `%LOCALAPPDATA%\Programs\DSH WSL` (changeable in the wizard) |
| Start menu / desktop | not created | optional desktop shortcut, Start-menu entry |
| Installed Apps entry | none | `DSH WSL <version>`, standard uninstall |
| Uninstall | delete the EXE | Uninstall from Installed Apps or the Start-menu entry |
| Relaunch after an in-app DSH update | restarts the Portable EXE | restarts the installed EXE |

Both packages use the same `appId` (`com.triagmas.wslwebshell`). The id was kept stable
across the rename so the application identity and the profile stay the same.
That is **not** a promise of an in-place upgrade: migrating an installation created by an
earlier build (for example the pre-rename `WSL Web Shell` installer) has **not been
verified**. The old and the new installation directories may coexist, and a previous
installation may have to be uninstalled manually.

## Installer behaviour

- **Offline**, assisted (not one-click) NSIS installer: no download at install time.
- **Per-user** by default, no elevation (`perMachine: false`, `allowElevation: false`).
- Creates a Start-menu entry, an optional desktop shortcut and an entry in
  **Settings → Apps → Installed apps**.
- `deleteAppDataOnUninstall: false`: the uninstaller removes only the installation
  directory. The profile (`%APPDATA%\wsl-web-shell`), the WSL runtime
  (`~/.local/share/wsl-web-shell`), DSH data and your projects are never touched.
- No service, no elevated helper, no startup task, no telemetry, no WSL or system
  configuration changes.

## Shared profile

Both variants use the **same profile directory** `%APPDATA%\wsl-web-shell` and the
same isolated data directory inside WSL and the same `dsh` installation, so the
settings and the installed DeepSeek Harness version are the same whichever you
start. (This is about the two files of one release, not about sharing data with a
globally installed `dsh` or with the official Windows DeepSeek Harness: the
isolated `DSH_HOME` starts empty.) Running both under one Windows account therefore
shares settings, logs, the owned-backend registry and the installed DSH version;
only one instance can run at a time.

The product was renamed from "WSL Web Shell" to "DSH WSL" in issue #14. The profile
directory keeps its original name on purpose: it holds the user's `config.json`,
logs, `owned-server.json` and `versions-cache.json`, so renaming it would silently
orphan that data. The Windows CI job proves the
continuity on both packages with `--profile-probe`.

## Building

```sh
npm run dist           # both packages into release/
npm run dist:portable  # portable EXE only
npm run dist:setup     # NSIS Setup EXE only
npm run dist:dir       # unpacked app for inspection
```

Packaging cross-builds from Linux/WSL for the portable target; the NSIS installer is
built on the Windows runner. Neither package is code-signed, so Windows SmartScreen
may warn about an unknown publisher — verify the SHA-256 from `SHA256SUMS.txt`.

## Windows CI

The `windows-package` job builds both artifacts from one `npm run dist` and then:

1. asserts that exactly the two expected names exist for the `package.json` version,
   each at least 50 MB (no `Select-Object -First 1`, no ambiguous glob),
2. writes `SHA256SUMS.txt` with both hashes and records names, sizes and hashes in
   the job summary,
4. proves that a pre-existing `%APPDATA%\wsl-web-shell` (config + logs) is still the
   live profile for the portable build and that no `%APPDATA%\DSH WSL` appears,
5. silently installs the Setup EXE into a temporary per-user directory and checks the
   installed files, the single uninstaller, the Start-menu shortcut and the
   Installed Apps entry,
6. runs the profile probe from the installed build,
7. uninstalls and asserts the installation directory, shortcut and uninstall entry
   are gone while the legacy profile and its files survive,
8. uploads both EXEs and `SHA256SUMS.txt` in one artifact.

## Probes

`--profile-probe=<file>` is kept for the profile continuity check: the packaged app
writes its name, `userData` path and packaged state, then exits before starting a
backend. It does not start, stop or update anything.

## Release checklist

1. Branch + Draft PR, review, Windows CI green.
2. Explicit owner approval for an exact-head squash merge.
3. After the merged CI run: assemble a **draft** prerelease with both EXEs and
   `SHA256SUMS.txt`.
4. Publishing a tag/release needs its own explicit approval.

## Artifact provenance

Locally built artifacts are byte-different (packager metadata), so a SHA-256 is only
meaningful together with its source commit and CI run. Pinned acceptance artifacts,
their commits and their digests are recorded in
[evidence/r02.md](evidence/r02.md), [evidence/r09.md](evidence/r09.md) and
[evidence/r091.md](evidence/r091.md).
