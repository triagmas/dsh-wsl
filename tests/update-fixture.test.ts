/**
 * Issue #17 — acceptance on an isolated fixture (no WSL, no owner installation).
 *
 * The test runs the **real** scripts (`INSPECT_SHARED_SCRIPT`,
 * `PREPARE_BACKUP_SCRIPT`, `UPDATE_SHARED_SCRIPT`, `ROLLBACK_SHARED_SCRIPT`)
 * against a throwaway npm prefix in a temporary directory, using stub packages
 * named `@deepseek-ai/dsh`. A shim `npm` maps the registry spec to a local
 * tarball, so the whole flow is offline and never touches a global prefix, an
 * owner installation or the network.
 *
 * Coverage:
 * - the happy path: one executable for the app and a login shell, in-place
 *   update, version verified at the same real path, restore;
 * - B1: no update without a verified, offline-restorable snapshot, and a
 *   snapshot-based recovery that works with a **completely broken registry**;
 * - B2: a changed real path, a symlinked package directory, a foreign package
 *   and a changed npm prefix are refused before anything is written;
 * - B3: login-shell divergence is a failure, before and after the install, and
 *   it restores the previous version;
 * - a foreign DSH process and a prefix that needs elevation stay refused.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INSPECT_SHARED_SCRIPT,
  PREPARE_BACKUP_SCRIPT,
  ROLLBACK_SHARED_SCRIPT,
  UPDATE_SHARED_SCRIPT,
} from '../src/main/wsl/update-args.js';
import { parseSharedDshReport } from '../src/main/core/dsh-locate.js';
import { planSharedUpdate, type SharedUpdatePlan } from '../src/main/core/update.js';
import type { DshInstallation } from '../src/main/core/dsh-locate.js';

const OLD = '0.2.1-rc.5';
const NEW = '0.2.2-rc.1';
const FOREIGN = '9.9.9';
const NODE = process.execPath;
const TX = '20261108T120000Z-a1b2';
const FIXTURE_LEASE = 'e'.repeat(32);

const npmAvailable = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
const shellAvailable = spawnSync('/bin/sh', ['-c', 'exit 0']).status === 0;
const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** One stub package: a JS bin that prints `dsh <version>`, like the real CLI. */
function writeStubPackage(directory: string, version: string, packageName = '@deepseek-ai/dsh'): string {
  const packageDir = join(directory, 'pkg');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: packageName, version, bin: { dsh: 'bin/dsh.js' }, private: true }, null, 2),
  );
  writeFileSync(
    join(packageDir, 'bin/dsh.js'),
    "#!/usr/bin/env node\nconsole.log(`dsh ${require('../package.json').version}`);\n",
  );
  chmodSync(join(packageDir, 'bin/dsh.js'), 0o755);
  const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', directory], {
    cwd: packageDir,
    encoding: 'utf8',
  });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
  return join(directory, packed.stdout.trim().split('\n').pop() ?? '');
}

/**
 * `npm` shim used by the fixture only.
 *
 * It answers `prefix -g` with the fixture prefix (so the scripts' agreement check
 * is exercised for real) and rewrites the exact registry spec the scripts build
 * into the matching local tarball, keeping the run offline.
 *
 * Three behaviours are switchable through files in the fixture home so a single
 * shim can model an unreachable registry and a shadowing shell change:
 * - `<home>/registry-off`: every install fails, like a registry that is offline;
 * - `<home>/shadow-on-install`: a successful install of the new version also
 *   shadows `dsh` in the login shell profile (B3 late divergence);
 * - `<home>/prefix-override`: `prefix -g` answers with another directory (B2).
 */
function writeNpmShim(path: string, prefix: string, tarballs: Record<string, string>, home: string): void {
  writeFileSync(
    path,
    [
      '#!/bin/bash',
      `real=${JSON.stringify(spawnSync('bash', ['-lc', 'command -v npm'], { encoding: 'utf8' }).stdout.trim())}`,
      `prefix=${JSON.stringify(prefix)}`,
      `home=${JSON.stringify(home)}`,
      `declare -A maps=(${Object.entries(tarballs)
        .map(([version, file]) => `[${JSON.stringify(version)}]=${JSON.stringify(file)}`)
        .join(' ')})`,
      'if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then',
      '  if [ -f "$home/prefix-override" ]; then cat "$home/prefix-override"; exit 0; fi',
      '  echo "$prefix"; exit 0',
      'fi',
      'if [ -f "$home/registry-off" ]; then echo "npm ERR! network request failed" >&2; exit 1; fi',
      'out=()',
      'installing=""',
      'for a in "$@"; do',
      '  case "$a" in',
      '    @deepseek-ai/dsh@*) v="${a#@deepseek-ai/dsh@}"; installing="$v"; out+=("${maps[$v]:-$a}") ;;',
      '    *) out+=("$a") ;;',
      '  esac',
      'done',
      '"$real" "${out[@]}" || exit $?',
      'if [ -n "$installing" ] && [ "$installing" = "' + NEW + '" ] && [ -f "$home/shadow-on-install" ]; then',
      '  printf \'export PATH="%s/foreign/bin:$PATH"\\n\' "$home" > "$home/.bash_profile"',
      'fi',
      'if [ -n "$installing" ] && [ "$installing" = "' + NEW + '" ] && [ -f "$home"/unshadow-on-install ]; then',
      '  printf \'export PATH="/usr/bin:/bin"\\n\' > "$home/.bash_profile"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

interface Fixture {
  home: string;
  prefix: string;
  npmShim: string;
  appRoot: string;
  env: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-fixture-'));
  scratch.push(home);
  const prefix = join(home, '.npm-global');
  const appRoot = join(home, 'app-data');
  const stubDir = join(home, 'stubs');
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  mkdirSync(appRoot, { recursive: true });

  const tarballs: Record<string, string> = {
    [OLD]: writeStubPackage(join(stubDir, 'old'), OLD),
    [NEW]: writeStubPackage(join(stubDir, 'new'), NEW),
    [FOREIGN]: writeStubPackage(join(stubDir, 'foreign'), FOREIGN),
  };
  // The scripts look for npm in `$HOME/.local/bin` first, so the shim lives there
  // and the inspection reports it as the installation's npm.
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  const npmShim = join(home, '.local/bin/npm');
  writeNpmShim(npmShim, prefix, tarballs, home);

  // A login shell resolves the fixture prefix, exactly like a real user profile.
  writeFileSync(join(home, '.profile'), `export PATH="${prefix}/bin:$PATH"\n`);
  writeFileSync(join(home, '.bash_profile'), `export PATH="${prefix}/bin:$PATH"\n`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${prefix}/bin:${join(NODE, '..')}:/usr/local/bin:/usr/bin:/bin`,
  };

  // Real npm installs the stub package into the throwaway prefix (offline).
  const installed = spawnSync(npmShim, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarballs[OLD] ?? '', ], {
    env,
    encoding: 'utf8',
  });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr}`);
  return { home, prefix, npmShim, appRoot, env };
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('/bin/sh', ['-c', script, ...args], { env, encoding: 'utf8' });
}

function versionAt(dshPath: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync('/bin/sh', ['-c', '"$0" --version', dshPath], { env, encoding: 'utf8' });
  return (result.stdout ?? '').trim();
}

function loginShellResolves(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('bash', ['-lc', 'command -v dsh'], { env, encoding: 'utf8' });
  return (result.stdout ?? '').trim();
}

function realPath(path: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync('/bin/sh', ['-c', 'readlink -f "$0"', path], { env, encoding: 'utf8' });
  return (result.stdout ?? '').trim();
}

/** Inspect, plan and prepare the snapshot exactly like the runner does. */
function arrange(fixture: Fixture): { dsh: string; plan: SharedUpdatePlan; snapshot: string } {
  const dsh = join(fixture.prefix, 'bin', 'dsh');
  const inspection = runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env);
  const report = parseSharedDshReport(`${inspection.stdout}\n${inspection.stderr}`);
  if (report.installation === null) throw new Error('the fixture installation must be detected');
  const planned = planSharedUpdate({
    distro: 'Fixture',
    targetVersion: NEW,
    appRoot: fixture.appRoot,
    installation: report.installation,
    customExecutable: false,
  });
  if (!planned.ok) throw new Error(`the fixture plan must be accepted: ${planned.reason}`);
  const plan = planned.plan;
  const backup = runScript(
    PREPARE_BACKUP_SCRIPT,
    [plan.dshPath, plan.prefix, plan.packageDir, plan.realPath, plan.installedVersion, TX, fixture.appRoot, '-', FIXTURE_LEASE],
    fixture.env,
  );
  if (backup.status !== 0) throw new Error(`fixture backup failed: ${backup.stderr}`);
  const snapshot = `${fixture.appRoot}/update/shared-backup-${TX}`;
  return { dsh, plan, snapshot };
}

function updateArgs(
  fixture: Fixture,
  plan: SharedUpdatePlan,
  snapshot: string,
  overrides: Partial<Record<number, string>> = {},
): string[] {
  const args = [
    plan.prefix,
    NEW,
    plan.installedVersion,
    plan.npmPath,
    NODE,
    TX,
    plan.dshPath,
    plan.packageDir,
    fixture.appRoot,
    '-',
    plan.realPath,
    snapshot,
  ];
  for (const [index, value] of Object.entries(overrides)) args[Number(index)] = value as string;
  return args;
}

describe.skipIf(!npmAvailable || !shellAvailable || !bashAvailable)('shared installation fixture (issue #17)', () => {
  it('resolves, snapshots, updates and restores the installation a shell sees', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');

    // 1. Same executable as a normal shell, before the update.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(loginShellResolves(fixture.env)).toBe(dsh);
    const realBefore = realPath(dsh, fixture.env);
    expect(realBefore.startsWith(join(fixture.prefix, 'lib/node_modules/@deepseek-ai/dsh'))).toBe(true);

    // 2. The app's inspection describes it as an npm global installation and
    //    records what a login shell resolves.
    const inspection = runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env);
    expect(inspection.status).toBe(0);
    const report = parseSharedDshReport(`${inspection.stdout}\n${inspection.stderr}`);
    const installation = report.installation;
    if (installation === null) throw new Error('the fixture installation must be detected');
    expect(installation.manager).toBe('npm');
    expect(installation.prefix).toBe(fixture.prefix);
    expect(installation.packageDir).toBe(`${fixture.prefix}/lib/node_modules/@deepseek-ai/dsh`);
    expect(installation.realPath).toBe(realBefore);
    expect(installation.loginShellRealPath).toBe(realBefore);
    expect(installation.loginShellVersion).toBe(OLD);
    expect(installation.writable).toBe(true);
    expect(installation.foreignProcesses).toBe(0);
    expect(installation.source).toBe('login-shell');
    expect(installation.version).toBe(OLD);

    const { plan, snapshot } = arrange(fixture);
    // The snapshot is complete before anything is installed (B1).
    expect(existsSync(`${snapshot}/payload/package.json`)).toBe(true);
    expect(existsSync(`${snapshot}/payload/bin/dsh.js`)).toBe(true);
    expect(existsSync(`${snapshot}/meta`)).toBe(true);
    expect(readdirSync(snapshot)).toContain('dsh.link');
    expect(readFileSync(`${snapshot}/meta`, 'utf8')).toContain('version=' + OLD);
    expect(readFileSync(`${snapshot}/meta`, 'utf8')).toContain('real=' + realBefore);

    // 3. The update changes that installation in place.
    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.stderr).not.toContain('could not be restored');
    expect(update.status).toBe(0);
    expect(update.stdout).toContain('a login shell resolves the updated executable');

    // 4. Both the app and an ordinary shell see the new version at the same path.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${NEW}`);
    expect(loginShellResolves(fixture.env)).toBe(dsh);
    expect(realPath(dsh, fixture.env)).toBe(realBefore);

    const after = parseSharedDshReport(runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env).stdout);
    expect(after.installation?.version).toBe(NEW);
    expect(after.installation?.loginShellVersion).toBe(NEW);

    // 5. The rollback restores the previous version from the snapshot.
    const rollback = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, NODE, plan.dshPath, plan.packageDir, TX, fixture.appRoot, realBefore, snapshot],
      fixture.env,
    );
    expect(rollback.status).toBe(0);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);

    // The existing snapshot is never deleted by a later transaction.
    expect(existsSync(`${snapshot}/payload/package.json`)).toBe(true);
  }, 120_000);

  it('refuses a rollback without resolved Node before touching a real fixture package', () => {
    const fixture = createFixture();
    const { plan, snapshot } = arrange(fixture);
    const packageJson = join(plan.packageDir, 'package.json');
    const before = readFileSync(packageJson, 'utf8');
    const restore = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, '-', plan.dshPath, plan.packageDir, TX, fixture.appRoot, plan.realPath, snapshot],
      fixture.env,
    );
    expect(restore.status).toBe(81);
    expect(restore.stderr).toContain('Node.js is unavailable');
    expect(readFileSync(packageJson, 'utf8')).toBe(before);
    expect(versionAt(plan.dshPath, fixture.env)).toBe(`dsh ${OLD}`);
    expect(existsSync(snapshot)).toBe(true);
  }, 120_000);

  // --- B1: no mutation without a verified, offline-restorable snapshot --------

  it('refuses to update when the snapshot location cannot be written', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan } = arrange(fixture);
    // A snapshot directory that cannot be created models a full disk or a
    // read-only app data root: the update must not start at all.
    rmSync(join(fixture.appRoot, 'update'), { recursive: true, force: true });
    chmodSync(fixture.appRoot, 0o555);
    try {
      const backup = runScript(
        PREPARE_BACKUP_SCRIPT,
        [plan.dshPath, plan.prefix, plan.packageDir, plan.realPath, plan.installedVersion, '20261108T120001Z-a1b3', fixture.appRoot, '-', FIXTURE_LEASE],
        fixture.env,
      );
      expect(backup.status).toBe(79);
      expect(backup.stderr).toContain('backup');
      // Nothing changed, and no half-written snapshot is left behind.
      expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
      expect(existsSync(`${fixture.appRoot}/update/shared-backup-20261108T120001Z-a1b3`)).toBe(false);
    } finally {
      chmodSync(fixture.appRoot, 0o755);
    }
  }, 60_000);

  it('refuses a symlinked backup directory instead of writing through it', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan } = arrange(fixture);
    const outside = join(fixture.home, 'outside');
    mkdirSync(outside, { recursive: true });
    rmSync(join(fixture.appRoot, 'update'), { recursive: true, force: true });
    symlinkSync(outside, join(fixture.appRoot, 'update'));
    const backup = runScript(
      PREPARE_BACKUP_SCRIPT,
      [plan.dshPath, plan.prefix, plan.packageDir, plan.realPath, plan.installedVersion, '20261108T120002Z-a1b4', fixture.appRoot, '-', FIXTURE_LEASE],
      fixture.env,
    );
    expect(backup.status).toBe(79);
    expect(backup.stderr).toContain('symlink');
    expect(readdirSync(outside)).toEqual([]);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 60_000);

  it('refuses to update when the snapshot is missing or incomplete', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);

    // An incomplete snapshot: the package payload is gone.
    rmSync(`${snapshot}/payload`, { recursive: true, force: true });
    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(80);
    expect(update.stderr).toContain('nothing was changed');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);

    // A snapshot that belongs to another installation is refused as well.
    const other = createFixture();
    const otherArrange = arrange(other);
    const foreignSnapshot = runScript(
      UPDATE_SHARED_SCRIPT,
      updateArgs(fixture, plan, otherArrange.snapshot),
      fixture.env,
    );
    expect([79, 80]).toContain(foreignSnapshot.status);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('restores the previous version offline after an interrupted in-place install', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const realBefore = plan.realPath;
    const pkg = plan.packageDir;

    // Model a crash during `npm install -g`: the package directory is left
    // half-written (entry point and metadata gone) and the registry is offline.
    rmSync(join(pkg, 'bin/dsh.js'), { force: true });
    rmSync(join(pkg, 'package.json'), { force: true });
    writeFileSync(join(fixture.home, 'registry-off'), '');
    expect(existsSync(join(pkg, 'package.json'))).toBe(false);

    const rollback = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, NODE, plan.dshPath, pkg, TX, fixture.appRoot, realBefore, snapshot],
      fixture.env,
    );
    expect(rollback.status).toBe(0);
    // The snapshot alone repaired the installation: npm was never consulted.
    expect(rollback.stdout).toContain('from the verified snapshot');
    expect(rollback.stdout).not.toContain('reinstalling @deepseek-ai/dsh');
    expect(readFileSync(join(pkg, 'package.json'), 'utf8')).toContain(OLD);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(realPath(dsh, fixture.env)).toBe(realBefore);
    expect(loginShellResolves(fixture.env)).toBe(dsh);

    // With the snapshot gone the same situation ends in an explicit failure,
    // not in a blind destructive restore.
    rmSync(snapshot, { recursive: true, force: true });
    rmSync(join(pkg, 'package.json'), { force: true });
    const failed = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, NODE, plan.dshPath, pkg, TX, fixture.appRoot, realBefore, snapshot],
      fixture.env,
    );
    expect(failed.status).toBe(74);
  }, 120_000);

  // --- B2: the installation identity is re-verified before mutation ----------

  it('refuses when the executable now points at a foreign package', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const foreignDir = join(fixture.home, 'foreign-install');
    mkdirSync(join(foreignDir, 'bin'), { recursive: true });
    writeFileSync(join(foreignDir, 'bin/dsh'), '#!/bin/sh\necho "dsh ' + FOREIGN + '"\n');
    chmodSync(join(foreignDir, 'bin/dsh'), 0o755);
    rmSync(dsh, { force: true });
    symlinkSync(join(foreignDir, 'bin/dsh'), dsh);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect([81, 82]).toContain(update.status);
    expect(update.stderr).toContain('nothing was changed');
    // The foreign installation is untouched, and so is the real one.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${FOREIGN}`);
    expect(readFileSync(`${plan.packageDir}/package.json`, 'utf8')).toContain(OLD);
  }, 120_000);

  it('refuses a package directory that became a symlink', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const moved = join(fixture.home, 'moved-package');
    spawnSync('mv', [plan.packageDir, moved]);
    symlinkSync(moved, plan.packageDir);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(81);
    expect(update.stderr).toContain('nothing was changed');
    // The linked-away package still reports the old version: nothing was replaced.
    expect(readFileSync(`${moved}/package.json`, 'utf8')).toContain(OLD);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('refuses a changed npm prefix', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const elsewhere = join(fixture.home, 'another-prefix');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(fixture.home, 'prefix-override'), `${elsewhere}\n`);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(76);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(existsSync(join(elsewhere, 'lib/node_modules/@deepseek-ai/dsh'))).toBe(false);
  }, 120_000);

  it('refuses when the package at that path is not DeepSeek Harness any more', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const manifest = join(plan.packageDir, 'package.json');
    writeFileSync(manifest, JSON.stringify({ name: '@other/tool', version: OLD }).concat('\n'));

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(81);
    expect(update.stderr).toContain('not an @deepseek-ai/dsh package');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  // --- B3: login-shell divergence is a failure, never a warning --------------

  it('refuses before installing when the login shell runs another executable', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const foreignBin = join(fixture.home, 'foreign/bin');
    mkdirSync(foreignBin, { recursive: true });
    writeFileSync(join(foreignBin, 'dsh'), '#!/bin/sh\necho "dsh ' + FOREIGN + '"\n');
    chmodSync(join(foreignBin, 'dsh'), 0o755);
    // The terminal would pick the other installation up first.
    writeFileSync(join(fixture.home, '.bash_profile'), `export PATH="${foreignBin}:$PATH"\n`);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(82);
    expect(update.stderr).toContain('login shell');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('rolls back when the login shell stops resolving the updated version', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const foreignBin = join(fixture.home, 'foreign/bin');
    mkdirSync(foreignBin, { recursive: true });
    writeFileSync(join(foreignBin, 'dsh'), '#!/bin/sh\necho "dsh ' + FOREIGN + '"\n');
    chmodSync(join(foreignBin, 'dsh'), 0o755);
    // The install itself succeeds, then the shell starts resolving something else.
    writeFileSync(join(fixture.home, 'shadow-on-install'), '');

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(84);
    expect(update.stderr).toContain('instead of the updated installation');
    expect(update.stdout).toContain('previous version restored');
    // Never green: the installation is back at the previous version.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(realPath(dsh, fixture.env)).toBe(plan.realPath);
    expect(readFileSync(`${plan.packageDir}/package.json`, 'utf8')).toContain(OLD);
  }, 120_000);


  // --- C1: an unresolvable login shell is a failure ---------------------------

  it('refuses when a login shell cannot resolve dsh at all (C1)', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    // The terminal has no `dsh` on its PATH any more (no bash profile entry).
    writeFileSync(join(fixture.home, '.bash_profile'), 'export PATH="/usr/bin:/bin"\n');

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(82);
    expect(update.stderr).toContain('cannot resolve dsh');
    expect(update.stderr).toContain('nothing was changed');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    // The plan refuses it as well, so the window would never offer the update.
    const inspection = parseSharedDshReport(
      runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], { ...fixture.env, PATH: `${fixture.prefix}/bin:${join(NODE, '..')}:/usr/bin:/bin` }).stdout,
    );
    const planned = planSharedUpdate({
      distro: 'Fixture',
      targetVersion: NEW,
      appRoot: fixture.appRoot,
      installation: { ...(inspection.installation as object), loginShellRealPath: null } as DshInstallation,
      customExecutable: false,
    });
    expect(planned.ok).toBe(false);
    expect(planned.ok === false && planned.reason).toBe('login-shell-mismatch');
  }, 120_000);

  it('refuses when a login shell cannot report the installed version (C1)', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const brokenBin = join(fixture.home, 'broken/bin');
    mkdirSync(brokenBin, { recursive: true });
    writeFileSync(join(brokenBin, 'dsh'), '#!/bin/sh\necho "unknown"\n');
    chmodSync(join(brokenBin, 'dsh'), 0o755);
    writeFileSync(join(fixture.home, '.bash_profile'), `export PATH="${brokenBin}:$PATH"\n`);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(82);
    expect(update.stderr).toContain('instead of [' + OLD + ']');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('rolls back when the login shell loses dsh after a successful install (C1)', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    // npm succeeds, then the shell profile no longer exports a `dsh` at all.
    writeFileSync(join(fixture.home, 'unshadow-on-install'), '');

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(84);
    expect(update.stderr).toContain('instead of the updated installation');
    expect(update.stdout).toContain('previous version restored');
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(readFileSync(`${plan.packageDir}/package.json`, 'utf8')).toContain(OLD);
  }, 120_000);

  // --- C2: a redirected ancestor must never be replaced ----------------------

  it('refuses to restore into a package directory whose parent became a symlink (C2)', () => {
    const fixture = createFixture();
    const { plan, snapshot } = arrange(fixture);
    const scope = join(fixture.prefix, 'lib/node_modules/@deepseek-ai');
    const outside = join(fixture.home, 'outside-scope');
    mkdirSync(join(outside, 'dsh'), { recursive: true });
    writeFileSync(join(outside, 'dsh/sentinel.txt'), 'do not touch\n');
    // The scope directory is replaced by a link pointing outside the prefix.
    spawnSync('mv', [scope, join(fixture.home, 'real-scope')]);
    symlinkSync(outside, scope);

    const rollback = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, NODE, plan.dshPath, plan.packageDir, TX, fixture.appRoot, plan.realPath, snapshot],
      fixture.env,
    );
    expect(rollback.status).toBe(81);
    expect(rollback.stderr).toContain('redirected installation path');
    // The foreign tree is untouched and nothing was written through the link.
    expect(readFileSync(join(outside, 'dsh/sentinel.txt'), 'utf8')).toBe('do not touch\n');
    expect(existsSync(join(outside, 'dsh/package.json'))).toBe(false);
    // The real package was moved aside by the test itself, not by the rollback.
    const movedReal = join(fixture.home, 'real-scope/dsh');
    expect(readFileSync(join(movedReal, 'package.json'), 'utf8')).toContain(OLD);
  }, 120_000);

  it('refuses to install when the package scope is redirected (C2)', () => {
    const fixture = createFixture();
    const { plan, snapshot } = arrange(fixture);
    const scope = join(fixture.prefix, 'lib/node_modules/@deepseek-ai');
    const outside = join(fixture.home, 'outside-scope2');
    mkdirSync(join(outside, 'dsh'), { recursive: true });
    writeFileSync(join(outside, 'dsh/sentinel.txt'), 'keep\n');
    spawnSync('mv', [scope, join(fixture.home, 'real-scope2')]);
    symlinkSync(outside, scope);

    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(81);
    expect(update.stderr).toContain('nothing was changed');
    expect(readFileSync(join(outside, 'dsh/sentinel.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(join(outside, 'dsh/package.json'))).toBe(false);
  }, 120_000);

  // --- C3: pre-existing temp trees and corrupt snapshots ---------------------

  it('never deletes a pre-existing backup temp directory (C3)', () => {
    const fixture = createFixture();
    const { plan } = arrange(fixture);
    const staleTx = '20261108T120009Z-c9d9';
    const stale = join(fixture.appRoot, 'update', `shared-backup-${staleTx}.tmp`);
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'sentinel.txt'), 'not yours\n');

    const backup = runScript(
      PREPARE_BACKUP_SCRIPT,
      [plan.dshPath, plan.prefix, plan.packageDir, plan.realPath, plan.installedVersion, staleTx, fixture.appRoot, '-', FIXTURE_LEASE],
      fixture.env,
    );
    expect(backup.status).toBe(79);
    expect(backup.stderr).toContain('already exists');
    // The unrelated tree survives untouched and no snapshot was published.
    expect(readFileSync(join(stale, 'sentinel.txt'), 'utf8')).toBe('not yours\n');
    expect(existsSync(join(fixture.appRoot, 'update', `shared-backup-${staleTx}`))).toBe(false);
    expect(versionAt(join(fixture.prefix, 'bin', 'dsh'), fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('refuses a corrupted but present snapshot and leaves the installation intact (C3)', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const pkg = plan.packageDir;
    const manifestBefore = readFileSync(`${snapshot}/manifest`, 'utf8');

    // The snapshot still exists, has a meta record and an entry point, but its
    // payload no longer matches the manifest.
    const manifest = readFileSync(`${snapshot}/manifest`, 'utf8').split('\n');
    const target = manifest.find((line) => line.includes('./bin/dsh.js'));
    expect(target).toBeDefined();
    writeFileSync(join(snapshot, 'payload/bin/dsh.js'), '#!/usr/bin/env node\nconsole.log("dsh ' + OLD + ' (patched)");\n');
    expect(readFileSync(`${snapshot}/manifest`, 'utf8')).toBe(manifestBefore);

    // 1. The update refuses before touching anything.
    const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
    expect(update.status).toBe(80);
    expect(update.stderr).toContain('integrity check');
    expect(readFileSync(`${pkg}/package.json`, 'utf8')).toContain(OLD);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);

    // 2. Recovery refuses to destroy a usable installation with a corrupt backup:
    //    the snapshot is not used, the registry is offline, so it fails loudly.
    writeFileSync(join(fixture.home, 'registry-off'), '');
    const rollback = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.prefix, OLD, fixture.npmShim, NODE, plan.dshPath, pkg, TX, fixture.appRoot, plan.realPath, snapshot],
      fixture.env,
    );
    expect(rollback.status).toBe(74);
    expect(rollback.stdout).not.toContain('from the verified snapshot');
    // Nothing was deleted: the working CLI is still there and still reports OLD.
    expect(readFileSync(`${pkg}/package.json`, 'utf8')).toContain(OLD);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  // --- existing guarantees ----------------------------------------------------

  it('fails closed while another DSH process uses the installation', async () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    const real = realPath(dsh, fixture.env);

    // A process whose command line contains the real path we are about to change.
    const foreign = spawn('bash', ['-c', 'exec -a "$0" sleep 30', real], { env: fixture.env, stdio: 'ignore' });
    try {
      const inspection = runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env);
      const report = parseSharedDshReport(inspection.stdout);
      if (report.installation === null) throw new Error('the fixture installation must be detected');
      expect(report.installation.foreignProcesses).toBeGreaterThan(0);

      const planned = planSharedUpdate({
        distro: 'Fixture',
        targetVersion: NEW,
        appRoot: fixture.appRoot,
        installation: report.installation,
        customExecutable: false,
      });
      expect(planned.ok).toBe(false);
      expect(planned.ok === false && planned.reason).toBe('foreign-process');

      // Even if the caller ignored the plan, the script refuses on its own.
      const update = runScript(UPDATE_SHARED_SCRIPT, updateArgs(fixture, plan, snapshot), fixture.env);
      expect(update.status).toBe(78);
      expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    } finally {
      foreign.kill('SIGKILL');
    }
  }, 120_000);

  it('never touches a prefix that needs elevated rights', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const { plan, snapshot } = arrange(fixture);
    // A read-only prefix models a system-wide installation the user cannot write.
    const locked = join(fixture.home, 'locked-prefix');
    mkdirSync(join(locked, 'lib/node_modules'), { recursive: true });
    chmodSync(join(locked, 'lib/node_modules'), 0o555);
    try {
      const update = runScript(
        UPDATE_SHARED_SCRIPT,
        updateArgs(fixture, plan, snapshot, { 0: locked }),
        fixture.env,
      );
      expect(update.status).not.toBe(0);
      // Either the prefix check, the npm-prefix agreement or the identity check
      // refuses first; all of them fail closed.
      expect([75, 76, 81]).toContain(update.status);
      expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
      expect(readFileSync(`${plan.packageDir}/package.json`, 'utf8')).toContain(OLD);
    } finally {
      chmodSync(join(locked, 'lib/node_modules'), 0o755);
    }
  }, 60_000);
});
