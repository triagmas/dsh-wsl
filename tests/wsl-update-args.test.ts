/**
 * Issue #12 — WSL update commands.
 *
 * Two layers:
 * 1. argument construction and validation (never any network or WSL);
 * 2. a real end-to-end run of the shipped `UPDATE_SCRIPT` under `/bin/sh` in a
 *    throwaway directory with a fake npm, which proves staging, verification,
 *    the swap and the rollback copy without touching any real installation.
 *
 * The end-to-end part needs a POSIX shell and is skipped on Windows.
 */
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  NPM_MARKER,
  NPM_PACKAGE,
  NPM_VIEW_SCRIPT,
  UPDATE_SCRIPT,
  buildInstallRuntimeArgs,
  buildNpmViewArgs,
  parseNpmMarker,
} from '../src/main/wsl/update-args.js';
import { ArgumentError } from '../src/main/wsl/args.js';

const ROOT = '~/.local/share/wsl-web-shell';
const NODE = '/home/u/.local/bin/node';

describe('update command construction', () => {
  it('checks the exact package version through /bin/sh', () => {
    const argv = buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: NODE });
    expect(argv.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c']);
    expect(argv[5]).toBe(NPM_VIEW_SCRIPT);
    expect(argv.slice(6)).toEqual([ROOT, '0.2.2-rc.1', NODE]);
    expect(NPM_VIEW_SCRIPT).toContain(`"${NPM_PACKAGE}@$ver"`);
    expect(NPM_VIEW_SCRIPT).toContain('view');
    // Read-only: the script must not install anything.
    expect(NPM_VIEW_SCRIPT).not.toContain('install');
  });

  it('installs into the isolated prefix with the resolved npm', () => {
    const argv = buildInstallRuntimeArgs(
      { distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: NODE },
      '/usr/bin/npm',
    );
    expect(argv.slice(6)).toEqual([ROOT, '0.2.2-rc.1', '/usr/bin/npm', NODE]);
    expect(argv[5]).toBe(UPDATE_SCRIPT);
  });

  it('keeps every safety step inside the script', () => {
    expect(UPDATE_SCRIPT).toContain('--global');
    expect(UPDATE_SCRIPT).toContain('--prefix "$stage"');
    expect(UPDATE_SCRIPT).toContain('--cache "$root/cache/npm"');
    // The staging prefix and the rollback copy live below the isolated root.
    expect(UPDATE_SCRIPT).toContain('stage="$upd/stage-$ts"');
    expect(UPDATE_SCRIPT).toContain('prev="$upd/previous-$ts"');
    expect(UPDATE_SCRIPT).toContain('mv "$rt" "$prev"');
    // Verification happens before and after the swap, with a restore on failure.
    expect(UPDATE_SCRIPT).toContain('"$stage/bin/dsh" --version');
    expect(UPDATE_SCRIPT).toContain('"$rt/bin/dsh" --version');
    expect(UPDATE_SCRIPT).toContain('mv "$prev" "$rt"');
    // Nothing global is touched.
    expect(UPDATE_SCRIPT).not.toContain('/usr/local/lib');
    expect(UPDATE_SCRIPT).not.toContain('/usr/lib/node_modules');
  });

  it('rejects unsafe values before they reach a command line', () => {
    expect(() => buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: 'latest', nodePath: null })).toThrow(
      ArgumentError,
    );
    expect(() =>
      buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1; id', nodePath: null }),
    ).toThrow(ArgumentError);
    expect(() => buildNpmViewArgs({ distro: 'Ubuntu', isolationRoot: '~', version: '0.2.2-rc.1', nodePath: null })).toThrow(
      ArgumentError,
    );
    expect(() =>
      buildNpmViewArgs({ distro: 'bad distro', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null }),
    ).toThrow(ArgumentError);
    expect(() =>
      buildInstallRuntimeArgs(
        { distro: 'Ubuntu', isolationRoot: ROOT, version: '0.2.2-rc.1', nodePath: null },
        'npm; rm -rf /',
      ),
    ).toThrow(ArgumentError);
  });

  it('parses the npm path the script announces', () => {
    expect(parseNpmMarker(`${NPM_MARKER} /usr/bin/npm`)).toBe('/usr/bin/npm');
    expect(parseNpmMarker(`${NPM_MARKER} npm`)).toBeNull();
    expect(parseNpmMarker('something else')).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('update script in an isolated test environment', () => {
  /**
   * Fake npm: understands exactly the global install invocation, writes a `dsh`
   * shim that reports `$FAKE_NPM_VERSION`, and records that it was called.
   */
  const FAKE_NPM = `#!/bin/sh
set -eu
mode="$FAKE_NPM_MODE"
prefix=""
target=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2;;
    --cache) shift 2;;
    --global|--no-audit|--no-fund) shift;;
    --loglevel=*) shift;;
    *) target="$1"; shift;;
  esac
done
printf '%s\\n' "$target" > "$FAKE_NPM_LOG"
if [ "$mode" = "fail" ]; then
  echo "npm ERR! network unreachable" >&2
  exit 7
fi
ver="\${target##*@}"
mkdir -p "$prefix/bin" "$prefix/lib/node_modules/@deepseek-ai/dsh"
if [ "$mode" = "wrong-version" ]; then ver="\${FAKE_WRONG_VERSION}"; fi
cat > "$prefix/bin/dsh" <<SHIM
#!/bin/sh
echo "$ver"
SHIM
chmod +x "$prefix/bin/dsh"
printf '{"name":"@deepseek-ai/dsh"}\\n' > "$prefix/lib/node_modules/@deepseek-ai/dsh/package.json"
`;

  async function setup(options: { mode: 'ok' | 'fail' | 'wrong-version'; installed?: string }) {
    const base = await mkdtemp(join(tmpdir(), 'wss-update-'));
    const root = join(base, 'root');
    await mkdir(join(root, 'runtime', 'bin'), { recursive: true });
    await mkdir(join(root, 'cache'), { recursive: true });
    await mkdir(join(root, 'update'), { recursive: true });
    const dsh = join(root, 'runtime', 'bin', 'dsh');
    await writeFile(dsh, `#!/bin/sh\necho "${options.installed ?? '0.2.1-rc.5'}"\n`, 'utf8');
    await chmod(dsh, 0o755);
    const npm = join(root, 'runtime', 'bin', 'npm');
    await writeFile(npm, FAKE_NPM, 'utf8');
    await chmod(npm, 0o755);
    const log = join(base, 'npm-calls.log');
    await writeFile(log, '', 'utf8');
    return { base, root, npm, log };
  }

  function runScript(root: string, version: string, npm: string, env: Record<string, string> = {}) {
    return spawnSync('/bin/sh', ['-c', UPDATE_SCRIPT, root, version, npm, '-'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  }

  it('installs the exact version, verifies it and keeps the previous tree', async () => {
    const { base, root, npm, log } = await setup({ mode: 'ok' });
    try {
      const result = runScript(root, '0.2.2-rc.1', npm, { FAKE_NPM_MODE: 'ok', FAKE_NPM_LOG: log });
      expect(result.status, result.stderr).toBe(0);

      const installed = spawnSync(join(root, 'runtime', 'bin', 'dsh'), ['--version'], { encoding: 'utf8' });
      expect(installed.stdout.trim()).toBe('0.2.2-rc.1');

      // The exact package spec reached npm, inside the isolated prefix.
      expect((await readFile(log, 'utf8')).trim()).toBe(`${NPM_PACKAGE}@0.2.2-rc.1`);

      const previous = (await readdir(join(root, 'update'))).filter((name) => name.startsWith('previous-'));
      expect(previous).toHaveLength(1);
      const previousDir = join(root, 'update', previous[0] ?? '');
      const kept = (await readdir(join(previousDir, 'bin'))).includes('dsh');
      expect(kept).toBe(true);
      const keptVersion = spawnSync(join(previousDir, 'bin', 'dsh'), ['--version'], { encoding: 'utf8' });
      expect(keptVersion.stdout.trim()).toBe('0.2.1-rc.5');

      // No staging directory is left behind.
      const leftovers = (await readdir(join(root, 'update'))).filter((name) => name.startsWith('stage-'));
      expect(leftovers).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('keeps the old install when npm fails', async () => {
    const { base, root, npm, log } = await setup({ mode: 'fail' });
    try {
      const result = runScript(root, '0.2.2-rc.1', npm, { FAKE_NPM_MODE: 'fail', FAKE_NPM_LOG: log });
      expect(result.status).toBe(7);
      const installed = spawnSync(join(root, 'runtime', 'bin', 'dsh'), ['--version'], { encoding: 'utf8' });
      expect(installed.stdout.trim()).toBe('0.2.1-rc.5');
      const entries = await readdir(join(root, 'update'));
      expect(entries.filter((name) => name.startsWith('previous-'))).toHaveLength(0);
      expect(entries.filter((name) => name.startsWith('stage-'))).toHaveLength(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('rolls back when the installed executable reports another version', async () => {
    const { base, root, npm, log } = await setup({ mode: 'wrong-version' });
    try {
      const result = runScript(root, '0.2.2-rc.1', npm, {
        FAKE_NPM_MODE: 'wrong-version',
        FAKE_NPM_LOG: log,
        FAKE_WRONG_VERSION: '0.2.1-rc.5',
      });
      expect(result.status).toBe(71);
      expect(result.stderr).toContain('staged version check failed');
      const installed = spawnSync(join(root, 'runtime', 'bin', 'dsh'), ['--version'], { encoding: 'utf8' });
      expect(installed.stdout.trim()).toBe('0.2.1-rc.5');
      const entries = await readdir(join(root, 'update'));
      expect(entries.filter((name) => name.startsWith('stage-'))).toHaveLength(0);
      // The old runtime was never moved away.
      const runtimeStillThere = await stat(join(root, 'runtime', 'bin', 'dsh'));
      expect(runtimeStillThere.isFile()).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
