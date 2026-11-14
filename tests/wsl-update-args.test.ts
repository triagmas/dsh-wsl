/**
 * Issues #12 and #17 — argument builders for the update scripts.
 *
 * Every value that reaches `wsl.exe` is either a module constant or a validated
 * positional parameter, so these tests check three things: the scripts keep the
 * safety rules the design promises, invalid values are rejected before anything
 * runs, and the builders never concatenate user input into shell text.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSPECT_SHARED_SCRIPT,
  NPM_PACKAGE,
  NPM_VIEW_SCRIPT,
  PREPARE_BACKUP_SCRIPT,
  PRUNE_SNAPSHOTS_SCRIPT,
  ROLLBACK_SHARED_SCRIPT,
  UPDATE_SHARED_SCRIPT,
  buildInspectSharedArgs,
  buildNpmViewArgs,
  buildPrepareBackupArgs,
  buildPruneSnapshotsArgs,
  buildRollbackSharedArgs,
  buildUpdateSharedArgs,
  parseBackupReport,
  parseNpmMarker,
  parsePruneReport,
} from '../src/main/wsl/update-args.js';
import { ArgumentError } from '../src/main/wsl/args.js';

const APP_ROOT = '/home/dev/.local/share/wsl-web-shell';
const PREFIX = '/home/dev/.npm-global';
const PKG = `${PREFIX}/lib/node_modules/@deepseek-ai/dsh`;
const DSH = `${PREFIX}/bin/dsh`;

const REAL = `${PKG}/bin/dsh.js`;
const SNAPSHOT = `${APP_ROOT}/update/shared-backup-20261107T101500Z-1a2b`;

const updateRequest = {
  distro: 'Ubuntu',
  appRoot: APP_ROOT,
  prefix: PREFIX,
  packageDir: PKG,
  dshPath: DSH,
  realPath: REAL,
  npmPath: '/usr/bin/npm',
  nodePath: '/usr/bin/node',
  transaction: '20261107T101500Z-1a2b',
  version: '0.2.2-rc.1',
  installedVersion: '0.2.1-rc.5',
  ownPid: 4242,
  snapshotDir: SNAPSHOT,
};

describe('npm view (read-only check)', () => {
  it('checks the exact version with the app cache and the resolved node', () => {
    const argv = buildNpmViewArgs({ distro: 'Ubuntu', appRoot: APP_ROOT, version: '0.2.2-rc.1', nodePath: '/usr/bin/node' });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', NPM_VIEW_SCRIPT]);
    expect(argv.slice(6)).toEqual([APP_ROOT, '0.2.2-rc.1', '/usr/bin/node']);
    expect(NPM_VIEW_SCRIPT).toContain(`${NPM_PACKAGE}@$ver`);
    expect(NPM_VIEW_SCRIPT).toContain('npm_config_cache');
    // The isolated runtime is not a requirement any more (issue #17).
    expect(NPM_VIEW_SCRIPT).not.toContain('runtime/bin');
  });

  it('rejects anything that is not an exact version', () => {
    for (const version of ['latest', '^0.2.2', '0.2.2; rm -rf /', '']) {
      expect(() => buildNpmViewArgs({ distro: 'Ubuntu', appRoot: APP_ROOT, version, nodePath: null })).toThrow(ArgumentError);
    }
  });

  it('parses the npm marker it prints', () => {
    expect(parseNpmMarker('__wsl_web_shell_npm__ /usr/bin/npm')).toBe('/usr/bin/npm');
    expect(parseNpmMarker('__wsl_web_shell_npm__ relative')).toBeNull();
    expect(parseNpmMarker('other output')).toBeNull();
  });
});

describe('shared installation inspection', () => {
  it('asks for the executable, the app root, node and the owned pid', () => {
    const argv = buildInspectSharedArgs({
      distro: 'Ubuntu',
      appRoot: APP_ROOT,
      dshPath: DSH,
      nodePath: '/usr/bin/node',
      ownPid: 4242,
    });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', INSPECT_SHARED_SCRIPT]);
    expect(argv.slice(6)).toEqual([DSH, APP_ROOT, '/usr/bin/node', '4242']);
  });

  it('resolves the distribution executable when no path is pinned', () => {
    const argv = buildInspectSharedArgs({ distro: 'Ubuntu', appRoot: APP_ROOT, dshPath: null, nodePath: null, ownPid: null });
    expect(argv.slice(6)).toEqual(['-', APP_ROOT, '-', '-']);
  });

  it('uses the login shell first and never a private runtime', () => {
    // `bash -lc "command -v dsh"` is exactly what an ordinary terminal does.
    expect(INSPECT_SHARED_SCRIPT).toContain('bash -lc "command -v dsh"');
    expect(INSPECT_SHARED_SCRIPT).toContain('legacy=');
    expect(INSPECT_SHARED_SCRIPT).not.toContain('runtime/bin:');
  });

  it('reports the npm prefix, the package and the writability', () => {
    for (const key of ['manager', 'prefix', 'package', 'writable', 'version', 'real', 'link', 'foreign', 'source']) {
      expect(INSPECT_SHARED_SCRIPT).toContain(`${key}=%s`);
    }
    expect(INSPECT_SHARED_SCRIPT).toContain('found=yes');
    expect(INSPECT_SHARED_SCRIPT).toContain('"$npm_bin" prefix -g');
    expect(INSPECT_SHARED_SCRIPT).toContain('pnpm root -g');
    expect(INSPECT_SHARED_SCRIPT).toContain('[ -w "$prefix" ]');
  });

  it('never signals anything while counting foreign processes', () => {
    expect(INSPECT_SHARED_SCRIPT).toContain('foreign_count');
    expect(INSPECT_SHARED_SCRIPT).not.toContain('kill');
  });

  it('rejects a relative executable path', () => {
    expect(() =>
      buildInspectSharedArgs({ distro: 'Ubuntu', appRoot: APP_ROOT, dshPath: 'bin/dsh', nodePath: null, ownPid: null }),
    ).toThrow(ArgumentError);
  });
});

describe('shared installation update', () => {
  it('passes every value as a positional parameter', () => {
    const argv = buildUpdateSharedArgs(updateRequest, updateRequest.transaction);
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', UPDATE_SHARED_SCRIPT]);
    expect(argv.slice(6)).toEqual([
      PREFIX,
      '0.2.2-rc.1',
      '0.2.1-rc.5',
      '/usr/bin/npm',
      '/usr/bin/node',
      '20261107T101500Z-1a2b',
      DSH,
      PKG,
      APP_ROOT,
      '4242',
      REAL,
      SNAPSHOT,
    ]);
  });

  it('never builds a shell string out of the values', () => {
    const argv = buildUpdateSharedArgs(updateRequest, updateRequest.transaction);
    // The script text is a constant: it is identical for every request.
    const other = buildUpdateSharedArgs({ ...updateRequest, version: '0.3.0' }, updateRequest.transaction);
    expect(other[5]).toBe(argv[5]);
    expect(argv[5]).not.toContain(PREFIX);
  });

  it('re-checks prefix, writability and foreign processes inside the script', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain('npm_bin" prefix -g');
    expect(UPDATE_SHARED_SCRIPT).toContain('report');
    expect(UPDATE_SHARED_SCRIPT).toContain('! -w "$prefix"');
    expect(UPDATE_SHARED_SCRIPT).toContain('foreign_count');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 75');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 76');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 78');
  });

  it('installs exactly the published package version', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain(`"${NPM_PACKAGE}@$ver"`);
    expect(UPDATE_SHARED_SCRIPT).toContain('install --global --prefix');
    expect(UPDATE_SHARED_SCRIPT).not.toContain('--force');
    expect(UPDATE_SHARED_SCRIPT).not.toMatch(/\bsudo\b/);
  });

  it('keeps a copy of the previous package and knows how to restore it', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain('shared-backup-$tx');
    expect(UPDATE_SHARED_SCRIPT).toContain('restore()');
    expect(UPDATE_SHARED_SCRIPT).toContain(`"${NPM_PACKAGE}@$installed"`);
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 72');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 73');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 74');
  });

  it('treats login-shell divergence as a failure, not a warning (B3)', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain('bash -lc "command -v dsh"');
    expect(UPDATE_SHARED_SCRIPT).toContain('a login shell resolves the updated executable');
    // Neither "warning" nor a silent success: the script exits and restores.
    expect(UPDATE_SHARED_SCRIPT).not.toContain('warning:');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 82');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 84');
  });

  it('requires the verified snapshot of this very installation (B1)', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain('snapshot_ok');
    expect(UPDATE_SHARED_SCRIPT).toContain('shared-backup-$tx');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 79');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 80');
    // The install must not be reachable without the snapshot checks.
    const installAt = UPDATE_SHARED_SCRIPT.indexOf('install --global --prefix');
    expect(UPDATE_SHARED_SCRIPT.indexOf('snapshot_ok "$snapshot" "$installed"')).toBeLessThan(installAt);
    expect(UPDATE_SHARED_SCRIPT.indexOf('snapshot_ok "$snapshot" "$installed"')).toBeLessThan(
      UPDATE_SHARED_SCRIPT.indexOf('install --global --prefix'),
    );
  });

  it('re-verifies the pinned real path and package identity before mutating (B2)', () => {
    expect(UPDATE_SHARED_SCRIPT).toContain('[ "$real" = "$real_path" ]');
    expect(UPDATE_SHARED_SCRIPT).toContain('exit 81');
    expect(UPDATE_SHARED_SCRIPT).toContain('readlink -f');
    expect(UPDATE_SHARED_SCRIPT).toContain('lib/node_modules/*');
    expect(UPDATE_SHARED_SCRIPT).toContain(`grep -q "\\"name\\"[[:space:]]*:[[:space:]]*\\"${NPM_PACKAGE}\\"`);
    const identityAt = UPDATE_SHARED_SCRIPT.indexOf('[ "$real" = "$real_path" ]');
    expect(identityAt).toBeLessThan(UPDATE_SHARED_SCRIPT.indexOf('install --global --prefix'));
  });

  it('prefers the offline snapshot restore over a registry reinstall', () => {
    const restoreBlock = UPDATE_SHARED_SCRIPT.slice(
      UPDATE_SHARED_SCRIPT.indexOf('restore() {'),
      UPDATE_SHARED_SCRIPT.indexOf('cache="$base/cache/npm"'),
    );
    expect(restoreBlock.indexOf('restore_snapshot')).toBeLessThan(restoreBlock.indexOf('falling back to reinstalling'));
  });

  it('rejects invalid versions, transactions and paths', () => {
    expect(() => buildUpdateSharedArgs({ ...updateRequest, version: 'latest' }, '20261107T101500Z-1a2b')).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs({ ...updateRequest, installedVersion: '^0.2.1' }, '20261107T101500Z-1a2b')).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs(updateRequest, '../../etc')).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs({ ...updateRequest, prefix: 'relative' }, updateRequest.transaction)).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs({ ...updateRequest, dshPath: '/a/../b' }, updateRequest.transaction)).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs({ ...updateRequest, npmPath: 'npm' }, updateRequest.transaction)).toThrow(ArgumentError);
    expect(() => buildUpdateSharedArgs({ ...updateRequest, ownPid: 0 }, updateRequest.transaction)).toThrow(ArgumentError);
  });

  it('rejects a prefix or transaction containing shell metacharacters', () => {
    for (const prefix of ['/home/dev/.npm-global;id', '/home/dev/$(id)', '/home/dev/`id`']) {
      expect(() => buildUpdateSharedArgs({ ...updateRequest, prefix }, updateRequest.transaction)).toThrow(ArgumentError);
    }
    expect(() => buildUpdateSharedArgs(updateRequest, '2026 11 07')).toThrow(ArgumentError);
  });
});

describe('backup script (B1)', () => {
  const backupRequest = {
    distro: 'Ubuntu',
    appRoot: APP_ROOT,
    prefix: PREFIX,
    packageDir: PKG,
    dshPath: DSH,
    realPath: REAL,
    installedVersion: '0.2.1-rc.5',
    transaction: '20261107T101500Z-1a2b',
    nodePath: '/home/dev/.local/bin/node',
    lease: 'd'.repeat(32),
  };

  it('receives every value as a positional parameter', () => {
    const argv = buildPrepareBackupArgs(backupRequest);
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PREPARE_BACKUP_SCRIPT]);
    // The resolved Node runtime is the second-to-last positional argument so the
    // version probe works on a minimal PATH (issue #27); the attempt lease follows
    // it and proves ownership of the temporary snapshot (review R02).
    expect(argv.slice(6)).toEqual([
      DSH,
      PREFIX,
      PKG,
      REAL,
      '0.2.1-rc.5',
      '20261107T101500Z-1a2b',
      APP_ROOT,
      '/home/dev/.local/bin/node',
      'd'.repeat(32),
    ]);
  });

  it('accepts a missing runtime as `-`', () => {
    const argv = buildPrepareBackupArgs({ ...backupRequest, nodePath: null });
    expect(argv[argv.length - 2]).toBe('-');
  });

  it('refuses a lease that is not 32-64 lowercase hex characters', () => {
    for (const lease of ['', 'abc', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(65)]) {
      expect(() => buildPrepareBackupArgs({ ...backupRequest, lease })).toThrow(ArgumentError);
    }
  });

  it('writes the lease into the temporary snapshot and removes it before the rename', () => {
    const leaseAt = PREPARE_BACKUP_SCRIPT.indexOf('token=%s');
    const renameAt = PREPARE_BACKUP_SCRIPT.indexOf('mv "$sn.tmp" "$sn"');
    expect(leaseAt).toBeGreaterThan(-1);
    expect(renameAt).toBeGreaterThan(leaseAt);
    // The tree is created with a plain mkdir, so an existing tree cannot be reused.
    expect(PREPARE_BACKUP_SCRIPT).toContain('mkdir "$sn.tmp"');
    expect(PREPARE_BACKUP_SCRIPT).not.toContain('mkdir -p "$sn.tmp/payload"');
  });

  it('rejects a runtime path that is not absolute', () => {
    expect(() => buildPrepareBackupArgs({ ...backupRequest, nodePath: 'node' })).toThrow(ArgumentError);
  });

  it('refuses symlinked or pre-existing snapshot locations (C3)', () => {
    expect(PREPARE_BACKUP_SCRIPT).toContain('[ ! -L "$sn" ]');
    expect(PREPARE_BACKUP_SCRIPT).toContain('[ -L "$sn.tmp" ]');
    expect(PREPARE_BACKUP_SCRIPT).toContain('[ -e "$sn" ] &&');
    expect(PREPARE_BACKUP_SCRIPT).toContain('[ -e "$sn.tmp" ] &&');
    expect(PREPARE_BACKUP_SCRIPT).toContain('exit 79');
    // A pre-existing temp tree is never removed: cleanup only removes what this
    // invocation created.
    expect(PREPARE_BACKUP_SCRIPT).not.toContain('rm -rf "$sn.tmp" 2>/dev/null ||');
    expect(PREPARE_BACKUP_SCRIPT).toContain('cleanup() { [ "$created" = "yes" ]');
    const removal = PREPARE_BACKUP_SCRIPT.slice(PREPARE_BACKUP_SCRIPT.indexOf('[ -e "$sn.tmp" ]'));
    expect(removal.indexOf('rm -rf')).toBeGreaterThan(0);
  });

  it('writes a content manifest and re-verifies it (C3)', () => {
    expect(PREPARE_BACKUP_SCRIPT).toContain('manifest_of "$sn.tmp/payload"');
    expect(PREPARE_BACKUP_SCRIPT).toContain('snapshot_ok "$sn" "$installed"');
    // Every consumer re-verifies the manifest before it deletes anything.
    for (const script of [UPDATE_SHARED_SCRIPT, ROLLBACK_SHARED_SCRIPT]) {
      expect(script).toContain('manifest_ok "$sn"');
      // The manifest is still produced by `cksum` over every payload file and
      // still re-verified by comparison, but in batches and through files, so a
      // failing stage cannot be hidden by a pipeline (#31).
      expect(script).toContain('cksum');
      expect(script).toContain('manifest_of() {');
      expect(script).toContain('cmp -s "$check"');
      const check = script.indexOf('manifest_ok "$sn"');
      expect(check).toBeGreaterThan(-1);
    }
    // The integrity check happens before the destructive restore.
    expect(UPDATE_SHARED_SCRIPT.indexOf('snapshot_ok "$snapshot" "$installed"')).toBeLessThan(
      UPDATE_SHARED_SCRIPT.indexOf('rm -rf "$target"'),
    );
    expect(ROLLBACK_SHARED_SCRIPT.indexOf('snapshot_ok "$snapshot" "$ver"')).toBeLessThan(
      ROLLBACK_SHARED_SCRIPT.indexOf('rm -rf "$pkg"'),
    );
  });

  it('refuses a redirected ancestry before replacing anything (C2)', () => {
    for (const script of [UPDATE_SHARED_SCRIPT, ROLLBACK_SHARED_SCRIPT, PREPARE_BACKUP_SCRIPT]) {
      expect(script).toContain('dest_trusted');
      expect(script).toContain('real_dir');
      expect(script).toContain('is not a real directory (symlinked or redirected)');
    }
    expect(UPDATE_SHARED_SCRIPT.indexOf('dest_trusted "$prefix" "$target"')).toBeLessThan(
      UPDATE_SHARED_SCRIPT.indexOf('rm -rf "$target"'),
    );
    expect(ROLLBACK_SHARED_SCRIPT.indexOf('dest_trusted "$prefix" "$pkg"')).toBeLessThan(
      ROLLBACK_SHARED_SCRIPT.indexOf('rm -rf "$pkg"'),
    );
  });

  it('copies the package and the executable shim state, then verifies both', () => {
    expect(PREPARE_BACKUP_SCRIPT).toContain('cp -a "$pkg/." "$sn.tmp/payload/"');
    expect(PREPARE_BACKUP_SCRIPT).toContain('dsh.link');
    expect(PREPARE_BACKUP_SCRIPT).toContain('version_of "$sn.tmp/payload/$entry"');
    expect(PREPARE_BACKUP_SCRIPT).toContain('printf "entry=%s');
    expect(PREPARE_BACKUP_SCRIPT).toContain('exit 80');
    expect(PREPARE_BACKUP_SCRIPT).toContain('exit 81');
  });

  it('rejects invalid inputs before touching the filesystem', () => {
    expect(() => buildPrepareBackupArgs({ ...backupRequest, installedVersion: 'latest' })).toThrow(ArgumentError);
    expect(() => buildPrepareBackupArgs({ ...backupRequest, transaction: '../../x' })).toThrow(ArgumentError);
    expect(() => buildPrepareBackupArgs({ ...backupRequest, realPath: 'relative/dsh.js' })).toThrow(ArgumentError);
    expect(() => buildPrepareBackupArgs({ ...backupRequest, packageDir: '/a/../b' })).toThrow(ArgumentError);
  });

  it('parses only a complete snapshot report', () => {
    const text = [
      '__dsh_wsl_backup__ path=/home/dev/app/update/shared-backup-20261107T101500Z-1a2b',
      '__dsh_wsl_backup__ version=0.2.1-rc.5',
      '__dsh_wsl_backup__ real=/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
      '__dsh_wsl_backup__ package=/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh',
      '__dsh_wsl_backup__ files=128',
    ].join('\n');
    expect(parseBackupReport(text)).toEqual({
      path: '/home/dev/app/update/shared-backup-20261107T101500Z-1a2b',
      version: '0.2.1-rc.5',
      realPath: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
      packageDir: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh',
      files: 128,
    });
    expect(parseBackupReport('__dsh_wsl_backup__ files=0')).toBeNull();
    expect(parseBackupReport(text.replace('files=128', 'files=0'))).toBeNull();
    expect(parseBackupReport(text.replace('version=0.2.1-rc.5', 'version=latest'))).toBeNull();
  });
});

describe('rollback script', () => {
  it('reinstalls the exact previous version', () => {
    const argv = buildRollbackSharedArgs(
      updateRequest,
      '0.2.1-rc.5',
      '20261107T101500Z-1a2b',
    );
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', ROLLBACK_SHARED_SCRIPT]);
    expect(argv.slice(6)).toEqual([
      PREFIX,
      '0.2.1-rc.5',
      '/usr/bin/npm',
      '/usr/bin/node',
      DSH,
      PKG,
      '20261107T101500Z-1a2b',
      APP_ROOT,
      REAL,
      SNAPSHOT,
    ]);
    expect(ROLLBACK_SHARED_SCRIPT).toContain('shared-backup-$tx');
    expect(ROLLBACK_SHARED_SCRIPT).toContain('exit 74');
  });

  it('restores from the verified snapshot before asking npm', () => {
    expect(ROLLBACK_SHARED_SCRIPT).toContain('restoring $ver from the verified snapshot');
    expect(ROLLBACK_SHARED_SCRIPT.indexOf('snapshot_ok "$snapshot" "$ver"')).toBeLessThan(
      ROLLBACK_SHARED_SCRIPT.indexOf('install --global --prefix'),
    );
    // A destination that is no longer the expected one is never replaced, and
    // neither is one whose ancestry was redirected (C2).
    expect(ROLLBACK_SHARED_SCRIPT).toContain('dest_trusted "$prefix" "$pkg" "$dsh"');
    expect(ROLLBACK_SHARED_SCRIPT).toContain('exit 81');
    expect(ROLLBACK_SHARED_SCRIPT).toContain('exit 74');
  });

  it('refuses a missing npm prefix', () => {
    expect(() => buildRollbackSharedArgs({ ...updateRequest, prefix: '' }, '0.2.1-rc.5', '20261107T101500Z-1a2b')).toThrow(
      ArgumentError,
    );
  });
});

describe('scripts never depend on the retired private runtime', () => {
  it('never installs, stages or activates anything in a private runtime', () => {
    for (const script of [NPM_VIEW_SCRIPT, UPDATE_SHARED_SCRIPT, ROLLBACK_SHARED_SCRIPT]) {
      expect(script).not.toContain('runtime');
    }
  });

  it('only uses the legacy runtime path to report that it exists', () => {
    // The inspection may look at it to tell the user it is no longer selected,
    // but it must never be executed, copied or updated.
    expect(INSPECT_SHARED_SCRIPT).toContain('[ -x "$root/runtime/bin/dsh" ] && legacy=yes');
    expect(INSPECT_SHARED_SCRIPT).not.toContain('runtime/bin/dsh" web');
  });

  it('never installs into an alternate prefix', () => {
    // The prefix always comes from the inspection, never from the script itself.
    expect(UPDATE_SHARED_SCRIPT).toContain('--prefix "$prefix"');
    expect(UPDATE_SHARED_SCRIPT).not.toContain('--prefix "$HOME"');
  });
});

describe('snapshot pruning', () => {
  it('keeps the newest snapshots and refuses a malformed count', () => {
    const tx = '20261114T021103Z-9d42';
    const argv = buildPruneSnapshotsArgs({ distro: 'Ubuntu', appRoot: APP_ROOT, keep: 2, transaction: tx });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PRUNE_SNAPSHOTS_SCRIPT]);
    expect(argv.slice(6)).toEqual([APP_ROOT, '2', tx]);
    const base = { distro: 'Ubuntu', appRoot: APP_ROOT, keep: 2, transaction: tx };
    expect(() => buildPruneSnapshotsArgs({ ...base, keep: -1 })).toThrow(ArgumentError);
    expect(() => buildPruneSnapshotsArgs({ ...base, keep: 1.5 })).toThrow(ArgumentError);
    expect(() => buildPruneSnapshotsArgs({ ...base, appRoot: 'relative' })).toThrow(ArgumentError);
    expect(() => buildPruneSnapshotsArgs({ ...base, transaction: '../../x' })).toThrow(ArgumentError);
    expect(() => buildPruneSnapshotsArgs({ ...base, distro: 'Ubuntu && rm -rf /' })).toThrow(ArgumentError);
  });

  it('walks only snapshot directories and never follows a symlink', () => {
    // `.tmp` trees belong to a running attempt and are removed under their lease.
    expect(PRUNE_SNAPSHOTS_SCRIPT).toContain('! -name "*.tmp"');
    expect(PRUNE_SNAPSHOTS_SCRIPT).toContain('[ -L "$p" ] && { echo "prune: $p is a symlink, kept" >&2; continue; }');
    expect(PRUNE_SNAPSHOTS_SCRIPT).toContain('case "$p" in "$upd"/shared-backup-[0-9]*)');
    expect(PRUNE_SNAPSHOTS_SCRIPT).toContain('sort -rn');
  });

  it('parses the removed paths and ignores anything else', () => {
    const text = [
      'prune: /home/dev/app/update/shared-backup-x is a symlink, kept',
      '__dsh_wsl_prune__ removed=/home/dev/app/update/shared-backup-20261107T101500Z-1a2b',
      'some other output',
    ].join('\n');
    expect(parsePruneReport(text)).toEqual(['/home/dev/app/update/shared-backup-20261107T101500Z-1a2b']);
    expect(parsePruneReport('nothing')).toEqual([]);
    // A relative or hostile path is never echoed back as a removal.
    expect(parsePruneReport('__dsh_wsl_prune__ removed=../../etc')).toEqual([]);
  });
});

// The pruning command is a shell script, so the only honest check of "keeps the
// newest and leaves everything else alone" is to run it against a real tree.
const itLinux = it.skipIf(process.platform !== 'linux');

describe('snapshot pruning on a real tree', () => {
  itLinux('keeps the newest snapshots and never touches foreign entries', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-prune-'));
    const upd = join(home, '.cache', 'wsl-web-shell', 'update');
    mkdirSync(upd, { recursive: true });
    const make = (name: string, mtime: number): void => {
      const dir = join(upd, name);
      mkdirSync(join(dir, 'payload'), { recursive: true });
      writeFileSync(join(dir, 'meta'), 'version=0.1.0\n');
      const touched = spawnSync('touch', ['-d', `@${mtime}`, dir]);
      expect(touched.status).toBe(0);
    };
    const names = [
      'shared-backup-20261101T000000Z-aaaa',
      'shared-backup-20261102T000000Z-bbbb',
      'shared-backup-20261103T000000Z-cccc',
      'shared-backup-20261104T000000Z-dddd',
    ];
    names.forEach((name, index) => make(name, 1_800_000_000 + index * 60));
    // A tree of a running attempt, an unrelated directory and a symlink to a
    // snapshot must all survive: each of them would be data loss if removed.
    const running = 'shared-backup-20261104T000000Z-eeee.tmp';
    mkdirSync(join(upd, running), { recursive: true });
    mkdirSync(join(upd, 'something-else'), { recursive: true });
    const link = 'shared-backup-20261105T000000Z-ffff';
    symlinkSync(join(upd, names[0] ?? ''), join(upd, link));

    // The snapshot of the running transaction is created first and deliberately
    // given the oldest mtime: a clock correction must not turn it into a victim.
    const currentTx = '20261100T000000Z-0000';
    const current = `shared-backup-${currentTx}`;
    make(current, 1_700_000_000);
    const run = spawnSync('/bin/sh', ['-c', PRUNE_SNAPSHOTS_SCRIPT, '-', '2', currentTx], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    expect(run.status).toBe(0);
    expect(existsSync(join(upd, names[0] ?? ''))).toBe(false);
    expect(existsSync(join(upd, names[1] ?? ''))).toBe(false);
    expect(existsSync(join(upd, names[2] ?? ''))).toBe(true);
    expect(existsSync(join(upd, names[3] ?? ''))).toBe(true);
    expect(existsSync(join(upd, current))).toBe(true);
    expect(existsSync(join(upd, running))).toBe(true);
    expect(existsSync(join(upd, 'something-else'))).toBe(true);
    // The link is checked without following it: its target was just pruned, so it
    // is dangling now, which is exactly the case `existsSync` reports as absent.
    expect(lstatSync(join(upd, link)).isSymbolicLink()).toBe(true);
    expect(parsePruneReport(run.stdout)).toHaveLength(2);
  });
});
