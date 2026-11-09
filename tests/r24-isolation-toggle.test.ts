import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_WRAPPER_SCRIPT } from '../src/main/wsl/args.js';

/**
 * Issue #24: with `isolateEnvironment=false` the backend exited with code 127.
 *
 * `dsh` is an npm shim (`#!/usr/bin/env node`), and `wsl.exe --exec /bin/bash`
 * starts with a minimal PATH that does not contain the runtime Node.js
 * directory. `START_WRAPPER_SCRIPT` prepended that directory only inside the
 * isolation branch, so turning isolation off made the shebang unresolvable.
 *
 * These tests run the real wrapper script offline against a fake `dsh` shim, so
 * they reproduce the exit 127 without touching a real DSH installation.
 */

interface ShimResult {
  status: number | null;
  stdout: string;
  stderr: string;
  payload: {
    argv: string[];
    cwd: string;
    env: Record<string, string | null>;
  } | null;
}

const SHIM_SOURCE = `#!/usr/bin/env node
const env = {
  HOME: process.env.HOME ?? null,
  DSH_HOME: process.env.DSH_HOME ?? null,
  DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME ?? null,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? null,
  TMPDIR: process.env.TMPDIR ?? null,
  WSL_WEB_SHELL_ISOLATION_ROOT: process.env.WSL_WEB_SHELL_ISOLATION_ROOT ?? null,
  PATH: process.env.PATH ?? '',
};
process.stdout.write('payload:' + JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env }) + '\\n');
`;

interface Fixture {
  root: string;
  home: string;
  dsh: string;
  node: string;
  isolationRoot: string;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wss-r24-'));
  const home = join(root, 'home');
  const bin = join(home, '.local', 'bin');
  await mkdir(bin, { recursive: true });
  await chmod(home, 0o755).catch(() => undefined);

  // A real Node.js in a directory that is deliberately not on the minimal PATH.
  const node = join(bin, 'node');
  await symlink(process.execPath, node);

  // The npm-style shim: `#!/usr/bin/env node` plus a JSON dump of its context.
  const dsh = join(bin, 'dsh');
  await writeFile(dsh, SHIM_SOURCE, 'utf8');
  await chmod(dsh, 0o755);

  const isolationRoot = join(home, '.local', 'share', 'wsl-web-shell');
  for (const dir of ['dsh-home', 'agents', 'cache', 'tmp', 'workspace', 'update']) {
    await mkdir(join(isolationRoot, dir), { recursive: true });
  }
  return { root, home, dsh, node, isolationRoot };
}

/** Run the production wrapper exactly as the supervisor does. */
function runWrapper(fixture: Fixture, isolationRootArg: string, workspace = '~'): ShimResult {
  const result = spawnSync(
    '/bin/bash',
    ['-c', START_WRAPPER_SCRIPT, fixture.dsh, '127.0.0.1', '3080', isolationRootArg, fixture.node, workspace],
    {
      encoding: 'utf8',
      env: {
        // The minimal environment `wsl.exe --exec` provides: no login PATH and
        // therefore no `~/.local/bin` entry where Node.js actually lives.
        PATH: '/usr/bin:/bin',
        HOME: fixture.home,
      },
    },
  );
  const stdout = result.stdout ?? '';
  const line = stdout.split('\n').find((entry) => entry.startsWith('payload:'));
  return {
    status: result.status,
    stdout,
    stderr: result.stderr ?? '',
    payload: line === undefined ? null : JSON.parse(line.slice('payload:'.length)),
  };
}

describe('issue #24: isolation toggle must not break the backend launch', () => {
  // The wrapper runs inside WSL/Linux; these cases spawn `/bin/bash`.
  const itPosix = it.skipIf(process.platform === 'win32');

  itPosix('starts the npm shim with isolation disabled (regression: exit 127)', async () => {
    const fixture = await createFixture();
    try {
      const run = runWrapper(fixture, '-');

      // Before the fix this was 127 with "env: 'node': No such file or directory".
      expect(run.stderr).not.toContain("env: 'node'");
      expect(run.status).toBe(0);
      expect(run.payload).not.toBeNull();

      // The resolved runtime directory is prepended regardless of isolation.
      expect((run.payload?.env.PATH ?? '').split(':')[0]).toBe(join(fixture.home, '.local', 'bin'));
      // Isolation is off: no app-specific data-root variables, real home, no
      // forced isolated workspace.
      expect(run.payload?.env.DSH_HOME).toBeNull();
      expect(run.payload?.env.DSH_AGENTS_HOME).toBeNull();
      expect(run.payload?.env.XDG_CACHE_HOME).toBeNull();
      expect(run.payload?.env.TMPDIR).toBeNull();
      expect(run.payload?.env.WSL_WEB_SHELL_ISOLATION_ROOT).toBeNull();
      expect(run.payload?.env.HOME).toBe(fixture.home);
      expect(run.payload?.cwd).toBe(fixture.home);
      // Same command line as before: the wrapper never rewrites the arguments.
      expect(run.payload?.argv).toEqual(['web', '--host', '127.0.0.1', '--port', '3080', '--no-open']);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  itPosix('keeps data isolation when it is enabled', async () => {
    const fixture = await createFixture();
    try {
      const run = runWrapper(fixture, '~/.local/share/wsl-web-shell');

      expect(run.status).toBe(0);
      expect(run.payload).not.toBeNull();
      expect((run.payload?.env.PATH ?? '').split(':')[0]).toBe(join(fixture.home, '.local', 'bin'));
      expect(run.payload?.env.DSH_HOME).toBe(join(fixture.isolationRoot, 'dsh-home'));
      expect(run.payload?.env.DSH_AGENTS_HOME).toBe(join(fixture.isolationRoot, 'agents'));
      expect(run.payload?.env.XDG_CACHE_HOME).toBe(join(fixture.isolationRoot, 'cache'));
      expect(run.payload?.env.TMPDIR).toBe(join(fixture.isolationRoot, 'tmp'));
      expect(run.payload?.env.WSL_WEB_SHELL_ISOLATION_ROOT).toBe(fixture.isolationRoot);
      expect(run.payload?.cwd).toBe(join(fixture.isolationRoot, 'workspace'));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  itPosix('survives true -> false -> true restarts without moving any data', async () => {
    const fixture = await createFixture();
    try {
      // A credential-like marker inside the isolated home must stay untouched.
      const marker = join(fixture.isolationRoot, 'dsh-home', 'credentials.json');
      await writeFile(marker, '{"apiKey":"isolated"}\n', 'utf8');
      const markerBefore = await readFile(marker, 'utf8');

      const isolatedFirst = runWrapper(fixture, '~/.local/share/wsl-web-shell');
      const realHome = runWrapper(fixture, '-');
      const isolatedAgain = runWrapper(fixture, '~/.local/share/wsl-web-shell');

      for (const run of [isolatedFirst, realHome, isolatedAgain]) {
        expect(run.status).toBe(0);
        expect((run.payload?.env.PATH ?? '').split(':')[0]).toBe(join(fixture.home, '.local', 'bin'));
        expect(run.payload?.argv).toEqual(['web', '--host', '127.0.0.1', '--port', '3080', '--no-open']);
      }

      // Isolation on -> credentials come from the isolated home.
      expect(isolatedFirst.payload?.env.DSH_HOME).toBe(join(fixture.isolationRoot, 'dsh-home'));
      expect(isolatedAgain.payload?.env.DSH_HOME).toBe(join(fixture.isolationRoot, 'dsh-home'));

      // Isolation off -> the real Linux home, and nothing is copied either way.
      expect(realHome.payload?.env.DSH_HOME).toBeNull();
      expect(realHome.payload?.cwd).toBe(fixture.home);

      expect(await readFile(marker, 'utf8')).toBe(markerBefore);
      // The wrapper never creates `~/.dsh` and never merges the two roots.
      await expect(lstat(join(fixture.home, '.dsh'))).rejects.toBeTruthy();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps the runtime PATH prepend outside the isolation branch', () => {
    // Static guard: the prepend must not be nested in the isolation block
    // again. The behavioural tests above are the primary regression check.
    const prepend = 'if [ "$node" != "-" ]; then export PATH="$(dirname "$node"):$PATH"; fi;';
    expect(START_WRAPPER_SCRIPT.split(prepend)).toHaveLength(2);
    expect(START_WRAPPER_SCRIPT).toContain(
      `export WSL_WEB_SHELL_ISOLATION_ROOT="$iroot"; fi; ${prepend}`,
    );
    // The isolation environment block itself must not touch PATH.
    const isolationBlock = START_WRAPPER_SCRIPT.slice(
      START_WRAPPER_SCRIPT.indexOf('export DSH_HOME='),
      START_WRAPPER_SCRIPT.indexOf(prepend),
    );
    expect(isolationBlock).not.toContain('PATH');
  });

  itPosix('fails with an explicit code when the runtime Node.js is missing', async () => {
    const fixture = await createFixture();
    try {
      // No resolved runtime: `$node` is "-", so nothing is prepended and the
      // shim cannot run. The wrapper must still report the failure clearly.
      const result = spawnSync(
        '/bin/bash',
        ['-c', START_WRAPPER_SCRIPT, fixture.dsh, '127.0.0.1', '3080', '-', '-', '~'],
        { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: fixture.home } },
      );
      expect(result.status).toBe(127);
      expect(result.stderr).toContain("env: 'node'");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
