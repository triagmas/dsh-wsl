/**
 * Issue #31 — the recovery snapshot must fit in its budget, and its leftovers
 * must not survive a killed attempt.
 *
 * The first real in-app CLI update (R26C) failed closed because the snapshot
 * stage never finished: the manifest was produced by one `cksum` fork per file,
 * measured at 134 s per pass for the 61 833-file DSH package, and the script needs
 * two passes. Batching the checksums keeps the recorded format byte-identical
 * while cutting the pass to 1.25 s.
 *
 * These tests drive the real script text in a disposable sandbox, so they need no
 * user installation and no WSL. On Windows the shell-driven cases are skipped,
 * exactly like the other `sh`-based suites.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLEAN_SNAPSHOT_SCRIPT,
  PREPARE_BACKUP_SCRIPT,
  ROLLBACK_SHARED_SCRIPT,
  buildCleanSnapshotArgs,
  parseCleanSnapshotReport,
} from '../src/main/wsl/update-args.js';

const VERSION = '0.2.1-rc.5';
const TX = '20261111T090000Z-a1b2';
const OTHER_TX = '20261110T123455Z-1f8f';
const posix = process.platform !== 'win32' && existsSync('/bin/sh');

const cleanups: string[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(prefix = 'wss-r31-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(root);
  return root;
}

/** npm-like installation used by the snapshot script. */
function sandbox(files: number) {
  const root = tempRoot();
  const prefix = join(root, 'prefix');
  const pkg = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
  const entry = join(pkg, 'lib', 'bin.js');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: VERSION }));
  writeFileSync(entry, `#!/bin/sh\nprintf 'dsh ${VERSION}\\n'\n`);
  chmodSync(entry, 0o755);
  for (let index = 0; index < files; index += 1) {
    const dir = join(pkg, 'lib', `d${index % 7}`, 'nested');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `file ${index}.js`), `// layer ${index}\n`);
  }
  const dsh = join(prefix, 'bin', 'dsh');
  symlinkSync('../lib/node_modules/@deepseek-ai/dsh/lib/bin.js', dsh);
  const nodeDir = join(root, 'node', 'bin');
  mkdirSync(nodeDir, { recursive: true });
  const node = join(nodeDir, 'node');
  writeFileSync(node, `#!/bin/sh\nprintf 'dsh ${VERSION}\\n'\n`);
  chmodSync(node, 0o755);
  const appRoot = join(root, 'app');
  mkdirSync(appRoot, { recursive: true });
  return { root, prefix, pkg, dsh, real: entry, appRoot, node, updateDir: join(appRoot, 'update') };
}

function runPrepare(
  box: ReturnType<typeof sandbox>,
  overrides: { tx?: string; path?: string; pkg?: string } = {},
) {
  return spawnSync(
    '/bin/sh',
    [
      '-c',
      PREPARE_BACKUP_SCRIPT,
      box.dsh,
      box.prefix,
      overrides.pkg ?? box.pkg,
      box.real,
      VERSION,
      overrides.tx ?? TX,
      box.appRoot,
      box.node,
    ],
    { encoding: 'utf8', cwd: box.root, env: { PATH: overrides.path ?? '/usr/bin:/bin', HOME: box.root } },
  );
}

function snapshotPath(box: ReturnType<typeof sandbox>, tx = TX): string {
  return join(box.updateDir, `shared-backup-${tx}`);
}

/** The algorithm the batching replaced, kept here to prove format compatibility. */
function legacyManifest(payload: string): string {
  const result = spawnSync(
    '/bin/sh',
    ['-c', 'find . -type f -print | LC_ALL=C sort | while IFS= read -r f; do cksum "$f"; done', ''],
    { encoding: 'utf8', cwd: payload, env: { PATH: '/usr/bin:/bin' } },
  );
  return result.stdout ?? '';
}

describe.skipIf(!posix)('the batched manifest is byte-identical to the per-file loop', () => {
  it('records the same lines for names with spaces and nested directories', () => {
    const box = sandbox(24);
    expect(runPrepare(box).status).toBe(0);
    const snapshot = snapshotPath(box);
    const recorded = readFileSync(join(snapshot, 'manifest'), 'utf8');
    expect(recorded).toBe(legacyManifest(join(snapshot, 'payload')));
    expect(recorded.split('\n').filter((line) => line !== '')).toHaveLength(26);
  });

  it('spawns a bounded number of checksum processes instead of one per file', () => {
    const box = sandbox(1200);
    const shimDir = join(box.root, 'shim');
    mkdirSync(shimDir, { recursive: true });
    const counter = join(box.root, 'spawns.txt');
    writeFileSync(counter, '');
    // The shim records every invocation and then hands over to the real `cksum`,
    // so the recorded output stays identical while the fork count is observable.
    writeFileSync(
      join(shimDir, 'cksum'),
      `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\nexec /usr/bin/cksum "$@"\n`,
    );
    chmodSync(join(shimDir, 'cksum'), 0o755);
    const result = runPrepare(box, { path: `${shimDir}:/usr/bin:/bin` });
    expect(result.status).toBe(0);
    const spawns = readFileSync(counter, 'utf8').split('\n').filter((line) => line !== '').length;
    // 1202 files at 500 per invocation: three invocations, plus one for the
    // closing verification. One per file would be over 1200.
    expect(spawns).toBeLessThanOrEqual(8);
    expect(spawns).toBeGreaterThan(0);
  });
});

describe.skipIf(!posix)('an ambiguous or unreadable payload is refused, not recorded', () => {
  it('refuses a file name that contains a newline', () => {
    const box = sandbox(3);
    writeFileSync(join(box.pkg, 'lib', 'bad\nname.js'), '// ambiguous\n');
    const result = runPrepare(box);
    expect(result.status).toBe(80);
    expect(result.stderr).toContain('contains a newline');
    expect(existsSync(snapshotPath(box))).toBe(false);
    // Only the directory this run created is removed; nothing else is touched.
    expect(readdirSync(box.updateDir).filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
  });

  it.skipIf(process.getuid?.() === 0)('refuses a file it cannot checksum', () => {
    const box = sandbox(3);
    const unreadable = join(box.pkg, 'lib', 'secret.js');
    writeFileSync(unreadable, '// hidden\n');
    chmodSync(unreadable, 0o000);
    const result = runPrepare(box);
    chmodSync(unreadable, 0o644);
    expect(result.status).toBe(80);
    expect(existsSync(snapshotPath(box))).toBe(false);
  });
});

describe.skipIf(!posix)('a snapshot that no longer matches its manifest is refused', () => {
  function takeSnapshot() {
    const box = sandbox(6);
    expect(runPrepare(box).status).toBe(0);
    return box;
  }

  /**
   * Run the rollback stage with an npm that refuses to do anything.
   *
   * A rejected snapshot falls back to reinstalling the previous version from the
   * registry, and this fake makes that fallback fail, so the exit code tells us
   * which path was taken: 0 only when the snapshot itself was restored.
   */
  function runRollback(box: ReturnType<typeof sandbox>, snapshot: string) {
    const npm = join(box.root, 'npm');
    writeFileSync(npm, `#!/bin/sh\nif [ "\${1:-}" = "prefix" ]; then printf '%s\\n' '${box.prefix}'; exit 0; fi\nexit 1\n`);
    chmodSync(npm, 0o755);
    return spawnSync(
      '/bin/sh',
      [
        '-c',
        ROLLBACK_SHARED_SCRIPT,
        box.prefix,
        VERSION,
        npm,
        box.node,
        box.dsh,
        box.pkg,
        TX,
        box.appRoot,
        box.real,
        snapshot,
      ],
      { encoding: 'utf8', cwd: box.root, env: { PATH: '/usr/bin:/bin', HOME: box.root } },
    );
  }

  it('accepts an untouched snapshot', () => {
    const box = takeSnapshot();
    const result = runRollback(box, snapshotPath(box));
    expect(result.status).toBe(0);
  });

  /** Assert that a tampered snapshot is refused and nothing is overwritten. */
  function expectRefusal(box: ReturnType<typeof sandbox>) {
    const installed = join(box.pkg, 'lib', 'a.js');
    const before = existsSync(installed) ? readFileSync(installed, 'utf8') : null;
    const result = runRollback(box, snapshotPath(box));
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(output).toContain('failed its integrity check');
    expect(output).not.toContain('restoring');
    // The rejected snapshot must never be copied over the working installation.
    expect(existsSync(installed) ? readFileSync(installed, 'utf8') : null).toBe(before);
    expect(result.status).toBe(74);
  }

  it('rejects a snapshot whose payload was altered', () => {
    const box = takeSnapshot();
    writeFileSync(join(snapshotPath(box), 'payload', 'lib', 'd0', 'nested', 'file 0.js'), '// tampered\n');
    expectRefusal(box);
  });

  it('rejects a snapshot with a missing payload file', () => {
    const box = takeSnapshot();
    rmSync(join(snapshotPath(box), 'payload', 'lib', 'd0', 'nested', 'file 0.js'));
    expectRefusal(box);
  });

  it('rejects a truncated manifest', () => {
    const box = takeSnapshot();
    const manifest = join(snapshotPath(box), 'manifest');
    const lines = readFileSync(manifest, 'utf8').split('\n');
    writeFileSync(manifest, `${lines.slice(0, 3).join('\n')}\n`);
    expectRefusal(box);
  });
});

describe.skipIf(!posix)('phase markers name the stage a killed attempt reached', () => {
  it('records phases and keeps them when the run fails', () => {
    const box = sandbox(4);
    writeFileSync(join(box.pkg, 'lib', 'bad\nname.js'), '// ambiguous\n');
    expect(runPrepare(box).status).toBe(80);
    const progress = join(box.updateDir, `${TX}.progress`);
    expect(existsSync(progress)).toBe(true);
    const phases = readFileSync(progress, 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.split(' ')[1]);
    expect(phases).toContain('start');
    expect(phases).toContain('copy');
    expect(phases.at(-1)).toBe('manifest');
  });

  it('removes the markers once the snapshot is verified', () => {
    const box = sandbox(4);
    expect(runPrepare(box).status).toBe(0);
    expect(readdirSync(box.updateDir).filter((name) => name.endsWith('.progress'))).toHaveLength(0);
    expect(readdirSync(box.updateDir).filter((name) => name.includes('manifest'))).toHaveLength(0);
  });
});

describe.skipIf(!posix)('CLEAN_SNAPSHOT_SCRIPT removes only its own transaction', () => {
  function interruptedAttempt(box: ReturnType<typeof sandbox>) {
    const tmp = join(box.updateDir, `shared-backup-${TX}.tmp`);
    mkdirSync(join(tmp, 'payload', 'lib'), { recursive: true });
    writeFileSync(join(tmp, 'payload', 'lib', 'bin.js'), 'half copied\n');
    writeFileSync(join(tmp, 'manifest'), '4294967295 12 ./lib/bin.js\n');
    writeFileSync(join(box.updateDir, `${TX}.progress`), `1700000000000 start\n1700000000000 copy\n`);
    writeFileSync(join(box.updateDir, `.${TX}.manifest-list`), 'partial\n');
    return tmp;
  }

  function runClean(box: ReturnType<typeof sandbox>, tx = TX) {
    return spawnSync('/bin/sh', ['-c', CLEAN_SNAPSHOT_SCRIPT, box.appRoot, tx], {
      encoding: 'utf8',
      cwd: box.root,
      env: { PATH: '/usr/bin:/bin', HOME: box.root },
    });
  }

  it('removes the temporary tree, the markers and the work files', () => {
    const box = sandbox(2);
    const tmp = interruptedAttempt(box);
    // A verified snapshot of another transaction must survive untouched.
    const other = join(box.updateDir, `shared-backup-${OTHER_TX}`);
    mkdirSync(join(other, 'payload'), { recursive: true });
    writeFileSync(join(other, 'meta'), 'version=0.2.1-rc.5\n');

    const result = runClean(box);
    expect(result.status).toBe(0);
    const report = parseCleanSnapshotReport(`${result.stdout ?? ''}${result.stderr ?? ''}`);
    expect(report).not.toBeNull();
    expect(report?.removed).toBe(true);
    expect(report?.phases.map((entry) => entry.phase)).toEqual(['start', 'copy']);
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(join(box.updateDir, `${TX}.progress`))).toBe(false);
    expect(existsSync(join(box.updateDir, `.${TX}.manifest-list`))).toBe(false);
    expect(existsSync(join(other, 'meta'))).toBe(true);
  });

  it('reports removed=no when the attempt left nothing behind', () => {
    const box = sandbox(2);
    const result = runClean(box);
    expect(result.status).toBe(0);
    expect(parseCleanSnapshotReport(`${result.stdout ?? ''}`)?.removed).toBe(false);
  });

  it('refuses to follow a symlinked temporary tree', () => {
    const box = sandbox(2);
    mkdirSync(box.updateDir, { recursive: true });
    const outside = join(box.root, 'outside');
    mkdirSync(join(outside, 'payload'), { recursive: true });
    writeFileSync(join(outside, 'payload', 'keep.js'), 'keep\n');
    symlinkSync(outside, join(box.updateDir, `shared-backup-${TX}.tmp`));
    const result = runClean(box);
    expect(result.status).toBe(79);
    expect(existsSync(join(outside, 'payload', 'keep.js'))).toBe(true);
  });

  it('refuses a temporary tree with content it did not create', () => {
    const box = sandbox(2);
    const tmp = join(box.updateDir, `shared-backup-${TX}.tmp`);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'unexpected.txt'), 'not ours\n');
    const result = runClean(box);
    expect(result.status).toBe(79);
    expect(existsSync(join(tmp, 'unexpected.txt'))).toBe(true);
  });

  it('rejects a malformed transaction id and a relative app root', () => {
    const box = sandbox(2);
    expect(runClean(box, '../etc').status).toBe(64);
    expect(runClean(box, 'a/b').status).toBe(64);
    expect(runClean(box, '').status).toBe(64);
    const args = spawnSync('/bin/sh', ['-c', CLEAN_SNAPSHOT_SCRIPT, 'relative/root', TX], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: box.root },
    });
    expect(args.status).toBe(79);
  });
});

describe('the cleanup command is built from validated arguments', () => {
  it('passes the app root and the transaction id as the only positional arguments', () => {
    expect(buildCleanSnapshotArgs({ distro: 'Ubuntu', appRoot: '~/root', transaction: TX })).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      '/bin/sh',
      '-c',
      CLEAN_SNAPSHOT_SCRIPT,
      '~/root',
      TX,
    ]);
  });

  it('passes `-` for an installation that does not isolate the environment', () => {
    const argv = buildCleanSnapshotArgs({ distro: 'Ubuntu', appRoot: '-', transaction: TX });
    expect(argv.at(-2)).toBe('-');
  });

  it('refuses a transaction id that is not a plain token', () => {
    expect(() => buildCleanSnapshotArgs({ distro: 'Ubuntu', appRoot: '~/r', transaction: '../x' })).toThrow();
    expect(() => buildCleanSnapshotArgs({ distro: 'Ubuntu', appRoot: '~/r', transaction: 'a b' })).toThrow();
  });

  it('refuses a relative app root', () => {
    expect(() => buildCleanSnapshotArgs({ distro: 'Ubuntu', appRoot: 'root', transaction: TX })).toThrow();
  });

  it('parses a report without a result line as unusable rather than successful', () => {
    expect(parseCleanSnapshotReport('__dsh_wsl_progress__ 1700000000000 copy\n')).toBeNull();
    expect(parseCleanSnapshotReport('')).toBeNull();
    expect(parseCleanSnapshotReport('__dsh_wsl_clean__ removed=no\n')?.removed).toBe(false);
  });
});
