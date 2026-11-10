/**
 * Issue #27 / R26A — the recovery snapshot must not depend on the caller's PATH.
 *
 * The shared `dsh` executable is normally an npm shim whose first line is
 * `#!/usr/bin/env node`. The update scripts run inside `wsl.exe --exec /bin/sh`,
 * which has a minimal PATH that does not contain the Node directory, so the
 * version probe in `PREPARE_BACKUP_SCRIPT` returned an empty string and the
 * snapshot aborted with code 81 (`reports [] instead of [0.2.1-rc.5]`) even
 * though nothing was wrong with the installation.
 *
 * These tests run the real script text in a disposable sandbox with
 * `PATH=/usr/bin:/bin` and a fake npm-style shim, so the failure is reproduced
 * without touching any user installation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArgumentError } from '../src/main/wsl/args.js';
import { PREPARE_BACKUP_SCRIPT, buildPrepareBackupArgs } from '../src/main/wsl/update-args.js';

const VERSION = '0.2.1-rc.5';
const TX = '20261110T100114Z-d380';
const LEASE = 'a'.repeat(32);
const HERE = process.cwd();
const posix = process.platform !== 'win32' && existsSync('/bin/sh');

interface Sandbox {
  root: string;
  prefix: string;
  pkg: string;
  dsh: string;
  real: string;
  appRoot: string;
  node: string;
  nodeDir: string;
}

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build an npm-like user installation: `<prefix>/bin/dsh` is a symlink to the
 * package entry point, and that entry point starts with `#!/usr/bin/env node`.
 */
function sandbox(options: { version?: string; symlinkPackage?: boolean } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'wss-r26-'));
  cleanups.push(root);
  const version = options.version ?? VERSION;
  const prefix = join(root, 'prefix');
  const pkg = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  const entry = join(pkg, 'lib', 'bin.js');
  writeFileSync(entry, `#!/usr/bin/env node\nprocess.stdout.write("dsh ${version}\\n");\n`);
  chmodSync(entry, 0o755);
  const dsh = join(prefix, 'bin', 'dsh');
  symlinkSync('../lib/node_modules/@deepseek-ai/dsh/lib/bin.js', dsh);
  // Node lives in its own directory that is deliberately absent from PATH.
  const nodeDir = join(root, 'node', 'bin');
  mkdirSync(nodeDir, { recursive: true });
  const node = join(nodeDir, 'node');
  writeFileSync(node, `#!/bin/sh\nprintf 'dsh ${version}\\n'\n`);
  chmodSync(node, 0o755);
  const appRoot = join(root, 'app');
  mkdirSync(appRoot, { recursive: true });
  return { root, prefix, pkg, dsh, real: entry, appRoot, node, nodeDir };
}

/** Run the backup script the way `wsl.exe --exec /bin/sh -c` would run it. */
function runBackup(
  box: Sandbox,
  overrides: { installedVersion?: string; node?: string; pkg?: string; path?: string } = {},
) {
  const installed = overrides.installedVersion ?? VERSION;
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      PREPARE_BACKUP_SCRIPT,
      box.dsh,
      box.prefix,
      overrides.pkg ?? box.pkg,
      box.real,
      installed,
      TX,
      box.appRoot,
      overrides.node ?? box.node,
      LEASE,
    ],
    {
      encoding: 'utf8',
      cwd: box.root,
      env: { PATH: overrides.path ?? '/usr/bin:/bin', HOME: box.root },
    },
  );
}

function snapshotDirs(appRoot: string): string[] {
  const dir = join(appRoot, 'update');
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('shared-backup-')) : [];
}

describe.skipIf(!posix)('PREPARE_BACKUP_SCRIPT keeps working on a minimal PATH (issue #27)', () => {
  it('snapshots an npm shim that needs `#!/usr/bin/env node` while Node is not on PATH', () => {
    const box = sandbox();
    const result = runBackup(box);
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).not.toContain('reports []');
    expect(result.status).toBe(0);
    const dirs = snapshotDirs(box.appRoot);
    expect(dirs).toHaveLength(1);
    const [name] = dirs;
    expect(name).toBeDefined();
    const snapshot = join(box.appRoot, 'update', String(name));
    expect(existsSync(join(snapshot, 'meta'))).toBe(true);
    expect(existsSync(join(snapshot, 'manifest'))).toBe(true);
    expect(existsSync(join(snapshot, 'payload', 'lib', 'bin.js'))).toBe(true);
    expect(readFileSync(join(snapshot, 'meta'), 'utf8')).toContain(`version=${VERSION}`);
  });

  it('keeps the version probe independent of the isolation switch', () => {
    // Isolation off passes `-` as the app data root: the snapshot then lives in
    // the per-user cache, and the Node directory still has to be used.
    const box = sandbox();
    const result = spawnSync(
      '/bin/sh',
      ['-c', PREPARE_BACKUP_SCRIPT, box.dsh, box.prefix, box.pkg, box.real, VERSION, TX, '-', box.node, LEASE],
      { encoding: 'utf8', cwd: box.root, env: { PATH: '/usr/bin:/bin', HOME: box.root } },
    );
    expect(result.status).toBe(0);
    const cache = join(box.root, '.cache', 'wsl-web-shell', 'update');
    expect(readdirSync(cache).some((name) => name.startsWith('shared-backup-'))).toBe(true);
  });

  it('still fails closed with an explicit reason when Node cannot be found at all', () => {
    const box = sandbox();
    const result = runBackup(box, { node: '-' });
    expect(result.status).toBe(81);
    expect(result.stderr).toContain(`reports [] instead of [${VERSION}]`);
    expect(snapshotDirs(box.appRoot)).toHaveLength(0);
  });

  it('rejects a PATH that cannot run the shim even though the node path argument is set', () => {
    // The node path argument points at something that does not exist: the fixed
    // script must not pretend the probe succeeded, and must still fail closed.
    const box = sandbox();
    const result = runBackup(box, { node: join(box.root, 'missing', 'node') });
    expect(result.status).toBe(81);
    expect(result.stderr).toContain('reports []');
    expect(snapshotDirs(box.appRoot)).toHaveLength(0);
  });

  it('refuses an installation whose reported version changed', () => {
    const box = sandbox({ version: '9.9.9' });
    const result = runBackup(box);
    expect(result.status).toBe(81);
    expect(result.stderr).toContain('reports [9.9.9] instead of');
    expect(snapshotDirs(box.appRoot)).toHaveLength(0);
  });

  it('refuses a package directory that resolves elsewhere', () => {
    const box = sandbox();
    const linked = join(box.root, 'linked-pkg');
    symlinkSync(box.pkg, linked);
    const result = runBackup(box, { pkg: linked });
    expect(result.status).toBe(81);
    expect(snapshotDirs(box.appRoot)).toHaveLength(0);
  });

  it('rejects a malformed node path argument', () => {
    const box = sandbox();
    const result = runBackup(box, { node: 'relative/node' });
    expect(result.status).toBe(64);
    expect(snapshotDirs(box.appRoot)).toHaveLength(0);
  });
});

describe('buildPrepareBackupArgs passes the resolved Node runtime', () => {
  const base = {
    distro: 'Ubuntu',
    appRoot: '/home/dev/.local/share/wsl-web-shell',
    prefix: '/home/dev/.local',
    packageDir: '/home/dev/.local/lib/node_modules/@deepseek-ai/dsh',
    dshPath: '/home/dev/.local/bin/dsh',
    realPath: '/home/dev/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    installedVersion: VERSION,
    transaction: TX,
    nodePath: '/home/dev/.local/bin/node',
    lease: LEASE,
  };

  it('sends the Node executable and the attempt lease as the last positional arguments', () => {
    const argv = buildPrepareBackupArgs({ ...base, nodePath: '/home/dev/.local/bin/node' });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PREPARE_BACKUP_SCRIPT]);
    expect(argv.slice(6)).toEqual([
      base.dshPath,
      base.prefix,
      base.packageDir,
      base.realPath,
      base.installedVersion,
      TX,
      base.appRoot,
      '/home/dev/.local/bin/node',
      LEASE,
    ]);
  });

  it('passes `-` when the runtime is unknown', () => {
    const argv = buildPrepareBackupArgs({ ...base, nodePath: null });
    expect(argv[argv.length - 2]).toBe('-');
    expect(argv[argv.length - 1]).toBe(LEASE);
  });

  it('rejects a lease that is not a plain token', () => {
    for (const lease of ['', 'short', 'A'.repeat(32), 'z'.repeat(32), 'a'.repeat(31), 'a b'.repeat(11)]) {
      expect(() => buildPrepareBackupArgs({ ...base, lease })).toThrow(ArgumentError);
    }
  });

  it('rejects an invalid Node path before anything runs', () => {
    expect(() => buildPrepareBackupArgs({ ...base, nodePath: 'bin/node' })).toThrow(ArgumentError);
    expect(() => buildPrepareBackupArgs({ ...base, nodePath: '/home/dev/../bin/node' })).toThrow(ArgumentError);
  });

  it('prepends the Node directory before the first version probe', () => {
    const prependAt = PREPARE_BACKUP_SCRIPT.indexOf('PATH="$(dirname "$node")');
    const firstProbe = PREPARE_BACKUP_SCRIPT.indexOf('version_of');
    expect(prependAt).toBeGreaterThan(-1);
    // `version_of` is first defined, then used; the definition must come before
    // any call, and the PATH line must be unconditional (outside `if` blocks).
    const firstCall = PREPARE_BACKUP_SCRIPT.indexOf('have="$(version_of');
    expect(firstCall).toBeGreaterThan(-1);
    expect(prependAt).toBeLessThan(firstCall);
    expect(firstProbe).toBeGreaterThan(-1);
    expect(PREPARE_BACKUP_SCRIPT).toContain('node="${7:--}"');
    expect(PREPARE_BACKUP_SCRIPT).toContain('case "$node" in');
  });
});

/** Guard against the test file drifting away from the repository root. */
it('runs from the repository root', () => {
  expect(existsSync(join(HERE, 'package.json'))).toBe(true);
});
