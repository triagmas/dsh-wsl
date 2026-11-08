/**
 * Issue #17 — acceptance on an isolated fixture (no WSL, no owner installation).
 *
 * The test runs the **real** update scripts (`INSPECT_SHARED_SCRIPT`,
 * `UPDATE_SHARED_SCRIPT`, `ROLLBACK_SHARED_SCRIPT`) against a throwaway npm prefix
 * in a temporary directory, using stub packages named `@deepseek-ai/dsh`. A shim
 * `npm` maps the registry spec to a local tarball, so the whole flow is offline
 * and never touches a global prefix, an owner installation or the network.
 *
 * What it proves:
 * - the app resolves and executes the same file an ordinary shell resolves
 *   (`bash -lc 'command -v dsh'` → the same realpath);
 * - the inspection detects an npm global installation, its prefix and writability;
 * - the update changes that installation in place, and afterwards both the app and
 *   a login shell see the new version at the same path;
 * - the recovery path reinstalls the previous exact version;
 * - a foreign DSH process makes the update fail closed without touching anything.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  INSPECT_SHARED_SCRIPT,
  ROLLBACK_SHARED_SCRIPT,
  UPDATE_SHARED_SCRIPT,
} from '../src/main/wsl/update-args.js';
import { parseSharedDshReport } from '../src/main/core/dsh-locate.js';
import { planSharedUpdate } from '../src/main/core/update.js';

const OLD = '0.2.1-rc.5';
const NEW = '0.2.2-rc.1';
const NODE = process.execPath;

const npmAvailable = spawnSync('npm', ['--version'], { encoding: 'utf8' }).status === 0;
const shellAvailable = spawnSync('/bin/sh', ['-c', 'exit 0']).status === 0;
const bashAvailable = spawnSync('bash', ['-c', 'exit 0']).status === 0;

const scratch: string[] = [];

afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** One stub package: a JS bin that prints `dsh <version>`, like the real CLI. */
function writeStubPackage(directory: string, version: string): string {
  const packageDir = join(directory, 'pkg');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'bin/dsh.js' }, private: true }, null, 2),
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
 */
function writeNpmShim(path: string, prefix: string, oldTarball: string, newTarball: string): void {
  writeFileSync(
    path,
    [
      '#!/bin/bash',
      `real=${JSON.stringify(spawnSync('bash', ['-lc', 'command -v npm'], { encoding: 'utf8' }).stdout.trim())}`,
      `prefix=${JSON.stringify(prefix)}`,
      `old=${JSON.stringify(oldTarball)}`,
      `new=${JSON.stringify(newTarball)}`,
      'if [ "$1" = "prefix" ] && [ "$2" = "-g" ]; then echo "$prefix"; exit 0; fi',
      'out=()',
      'for a in "$@"; do',
      '  case "$a" in',
      `    "@deepseek-ai/dsh@${OLD}") out+=("$old") ;;`,
      `    "@deepseek-ai/dsh@${NEW}") out+=("$new") ;;`,
      '    *) out+=("$a") ;;',
      '  esac',
      'done',
      'exec "$real" "${out[@]}"',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
}

interface Fixture {
  home: string;
  prefix: string;
  npmShim: string;
  env: NodeJS.ProcessEnv;
}

function createFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dsh-wsl-fixture-'));
  scratch.push(home);
  const prefix = join(home, '.npm-global');
  const stubDir = join(home, 'stubs');
  mkdirSync(stubDir, { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });

  const oldTarball = writeStubPackage(join(stubDir, 'old'), OLD);
  const newTarball = writeStubPackage(join(stubDir, 'new'), NEW);
  // The scripts look for npm in `$HOME/.local/bin` first, so the shim lives there
  // and the inspection reports it as the installation's npm.
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  const npmShim = join(home, '.local/bin/npm');
  writeNpmShim(npmShim, prefix, oldTarball, newTarball);

  // A login shell resolves the fixture prefix, exactly like a real user profile.
  writeFileSync(join(home, '.profile'), `export PATH="${prefix}/bin:$PATH"\n`);
  writeFileSync(join(home, '.bash_profile'), `export PATH="${prefix}/bin:$PATH"\n`);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${prefix}/bin:${join(NODE, '..')}:/usr/local/bin:/usr/bin:/bin`,
  };

  // Real npm installs the stub package into the throwaway prefix (offline).
  const installed = spawnSync(npmShim, ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', oldTarball], {
    env,
    encoding: 'utf8',
  });
  if (installed.status !== 0) throw new Error(`fixture install failed: ${installed.stderr}`);
  return { home, prefix, npmShim, env };
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

describe.skipIf(!npmAvailable || !shellAvailable || !bashAvailable)('shared installation fixture (issue #17)', () => {
  it('resolves, inspects, updates and restores the installation a shell sees', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');

    // 1. Same executable as a normal shell, before the update.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    expect(loginShellResolves(fixture.env)).toBe(dsh);
    const realBefore = realPath(dsh, fixture.env);
    expect(realBefore.startsWith(join(fixture.prefix, 'lib/node_modules/@deepseek-ai/dsh'))).toBe(true);

    // 2. The app's inspection describes it as an npm global installation.
    const inspection = runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env);
    expect(inspection.status).toBe(0);
    const report = parseSharedDshReport(`${inspection.stdout}\n${inspection.stderr}`);
    expect(report.found).toBe(true);
    const installation = report.installation;
    if (installation === null) throw new Error('the fixture installation must be detected');
    expect(installation.manager).toBe('npm');
    expect(installation.prefix).toBe(fixture.prefix);
    expect(installation.packageDir).toBe(`${fixture.prefix}/lib/node_modules/@deepseek-ai/dsh`);
    expect(installation.realPath).toBe(realBefore);
    expect(installation.writable).toBe(true);
    expect(installation.foreignProcesses).toBe(0);
    expect(installation.source).toBe('login-shell');
    expect(installation.version).toBe(OLD);

    // 3. The plan accepts it, which is what the confirmation window shows.
    const plan = planSharedUpdate({
      distro: 'Fixture',
      targetVersion: NEW,
      appRoot: '-',
      installation,
      customExecutable: false,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // 4. The update changes that installation in place.
    const update = runScript(
      UPDATE_SHARED_SCRIPT,
      [
        plan.plan.prefix,
        NEW,
        OLD,
        fixture.npmShim,
        NODE,
        '20261108T120000Z-a1b2',
        plan.plan.dshPath,
        plan.plan.packageDir,
        '-',
        '-',
      ],
      fixture.env,
    );
    expect(update.stderr).not.toContain('could not be restored');
    expect(update.status).toBe(0);
    expect(update.stdout).toContain('a login shell resolves the updated executable');

    // 5. Both the app and an ordinary shell see the new version at the same path.
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${NEW}`);
    expect(loginShellResolves(fixture.env)).toBe(dsh);
    expect(realPath(dsh, fixture.env)).toBe(realBefore);

    const after = parseSharedDshReport(
      runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env).stdout,
    );
    expect(after.installation?.version).toBe(NEW);

    // 6. The recovery path reinstalls the previous exact version.
    const rollback = runScript(
      ROLLBACK_SHARED_SCRIPT,
      [plan.plan.prefix, OLD, fixture.npmShim, NODE, plan.plan.dshPath, plan.plan.packageDir, '20261108T120000Z-a1b2', '-'],
      fixture.env,
    );
    expect(rollback.status).toBe(0);
    expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
  }, 120_000);

  it('fails closed while another DSH process uses the installation', async () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    const real = realPath(dsh, fixture.env);

    // A process whose command line contains the real path we are about to change.
    const foreign = spawn('bash', ['-c', 'exec -a "$0" sleep 30', real], { env: fixture.env, stdio: 'ignore' });
    try {
      const inspection = runScript(INSPECT_SHARED_SCRIPT, ['-', '-', NODE, '-'], fixture.env);
      const report = parseSharedDshReport(inspection.stdout);
      if (report.installation === null) throw new Error('the fixture installation must be detected');
      expect(report.installation.foreignProcesses).toBeGreaterThan(0);

      const plan = planSharedUpdate({
        distro: 'Fixture',
        targetVersion: NEW,
        appRoot: '-',
        installation: report.installation,
        customExecutable: false,
      });
      expect(plan.ok).toBe(false);
      expect(plan.ok === false && plan.reason).toBe('foreign-process');

      // Even if the caller ignored the plan, the script refuses on its own.
      const update = runScript(
        UPDATE_SHARED_SCRIPT,
        [fixture.prefix, NEW, OLD, fixture.npmShim, NODE, '20261108T120000Z-a1b2', dsh, report.installation.packageDir ?? '-', '-', '-'],
        fixture.env,
      );
      expect(update.status).toBe(78);
      expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
    } finally {
      foreign.kill('SIGKILL');
    }
  }, 120_000);

  it('never touches a prefix that needs elevated rights', () => {
    const fixture = createFixture();
    const dsh = join(fixture.prefix, 'bin', 'dsh');
    // A read-only prefix models a system-wide installation the user cannot write.
    const locked = join(fixture.home, 'locked-prefix');
    mkdirSync(join(locked, 'lib/node_modules'), { recursive: true });
    chmodSync(join(locked, 'lib/node_modules'), 0o555);
    try {
      const update = runScript(
        UPDATE_SHARED_SCRIPT,
        [locked, NEW, OLD, fixture.npmShim, NODE, '20261108T120000Z-a1b2', dsh, '-', '-', '-'],
        fixture.env,
      );
      expect(update.status).not.toBe(0);
      // Either the prefix check or the npm-prefix agreement refuses first.
      expect([75, 76]).toContain(update.status);
      expect(versionAt(dsh, fixture.env)).toBe(`dsh ${OLD}`);
      expect(existsSync(join(fixture.prefix, 'lib/node_modules/@deepseek-ai/dsh/package.json'))).toBe(true);
      expect(readFileSync(join(fixture.prefix, 'lib/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).toContain(OLD);
    } finally {
      chmodSync(join(locked, 'lib/node_modules'), 0o755);
    }
  }, 60_000);
});
