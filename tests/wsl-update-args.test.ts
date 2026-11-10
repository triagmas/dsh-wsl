/**
 * Issues #12 and #17 — argument builders for the update scripts.
 *
 * Every value that reaches `wsl.exe` is either a module constant or a validated
 * positional parameter, so these tests check three things: the scripts keep the
 * safety rules the design promises, invalid values are rejected before anything
 * runs, and the builders never concatenate user input into shell text.
 */
import { describe, expect, it } from 'vitest';
import {
  INSPECT_SHARED_SCRIPT,
  NPM_PACKAGE,
  NPM_VIEW_SCRIPT,
  PREPARE_BACKUP_SCRIPT,
  ROLLBACK_SHARED_SCRIPT,
  UPDATE_SHARED_SCRIPT,
  buildInspectSharedArgs,
  buildNpmViewArgs,
  buildPrepareBackupArgs,
  buildRollbackSharedArgs,
  buildUpdateSharedArgs,
  parseBackupReport,
  parseNpmMarker,
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
  };

  it('receives every value as a positional parameter', () => {
    const argv = buildPrepareBackupArgs(backupRequest);
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PREPARE_BACKUP_SCRIPT]);
    // The resolved Node runtime is the last positional argument so the version
    // probe works on a minimal PATH (issue #27).
    expect(argv.slice(6)).toEqual([
      DSH,
      PREFIX,
      PKG,
      REAL,
      '0.2.1-rc.5',
      '20261107T101500Z-1a2b',
      APP_ROOT,
      '/home/dev/.local/bin/node',
    ]);
  });

  it('accepts a missing runtime as `-`', () => {
    const argv = buildPrepareBackupArgs({ ...backupRequest, nodePath: null });
    expect(argv[argv.length - 1]).toBe('-');
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
      expect(script).toContain('cksum');
      expect(script).toContain('cmp -s -');
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
