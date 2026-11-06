/**
 * R02-B0 regression suite: isolated backend environment.
 *
 * Covers the isolation plan, the exact launcher arguments (variables are
 * exported inside the distribution, never forwarded from Windows), the
 * read-only runtime probe with isolated-runtime priority, directory preparation
 * that cannot escape the root, and the supervisor wiring that fails closed.
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import {
  ISOLATION_DISABLED,
  buildIsolationPlan,
  isValidIsolationRoot,
  isValidRuntimeBinary,
  isolationRootArg,
  resolveLaunchWorkspace,
} from '../src/main/core/isolation.js';
import { normalizeConfig, applyConfigPatch, requiresRestart } from '../src/main/core/config.js';
import {
  PREPARE_ISOLATION_SCRIPT,
  PROBE_PROCESS_SCRIPT,
  RESOLVE_RUNTIME_SCRIPT,
  SCRIPT_ARGV0,
  START_WRAPPER_SCRIPT,
  ArgumentError,
  buildPrepareIsolationArgs,
  buildProbeProcessArgs,
  buildResolveRuntimeArgs,
  buildStartServerArgs,
} from '../src/main/wsl/args.js';
import { parseProcessProbe, parseRuntimeProbe } from '../src/main/wsl/output.js';
import { DEFAULT_CONFIG, ISOLATION_ROOT_DEFAULT } from '../src/shared/types.js';
import { createHarness, lastStatus } from './helpers.js';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = '~/.local/share/wsl-web-shell';
const launchBase = {
  distro: 'Ubuntu',
  dshPath: '/opt/wsl-web-shell/runtime/bin/dsh',
  port: 3080,
  workspace: '~',
  isolationRoot: ROOT,
  nodePath: '/usr/bin/node',
};

describe('isolation root validation', () => {
  it('accepts the default and absolute POSIX roots', () => {
    for (const root of [ISOLATION_ROOT_DEFAULT, ROOT, '~/sandbox', '/srv/wsl-web-shell', '/']) {
      expect(isValidIsolationRoot(root)).toBe(true);
    }
  });

  it('rejects relative, escaping and shell-significant roots', () => {
    const rejected = [
      '',
      'sandbox',
      '~/.local/../secret',
      '/srv/../etc',
      '/srv/a b',
      '/srv/$(id)',
      '/srv/`id`',
      '/srv/a;rm -rf /',
      '/srv/a|b',
      '/srv/a&b',
      '/srv/a"b',
      "/srv/a'b",
      'C:\\Users\\me',
      '/srv/a\nb',
      '/srv/a\tb',
      `/${'a'.repeat(600)}`,
      42,
      null,
    ];
    for (const root of rejected) expect(isValidIsolationRoot(root)).toBe(false);
  });

  it('accepts only absolute sandbox-free runtime binaries', () => {
    expect(isValidRuntimeBinary('/usr/bin/node')).toBe(true);
    expect(isValidRuntimeBinary('/opt/wsl-web-shell/runtime/bin/node')).toBe(true);
    // Resolved binaries are absolute; a tilde form is never a runtime binary.
    for (const value of ['node', `${ROOT}/runtime/bin/node`, '/usr/../bin/node', '/usr/bin/node --inspect', '/usr/bin/no de']) {
      expect(isValidRuntimeBinary(value)).toBe(false);
    }
  });
});

describe('isolation plan', () => {
  it('derives every path below the single root without duplicate separators', () => {
    const plan = buildIsolationPlan({ enabled: true, root: `${ROOT}/` });
    expect(plan).toEqual({
      enabled: true,
      root: ROOT,
      runtimeBin: `${ROOT}/runtime/bin`,
      dshHome: `${ROOT}/dsh-home`,
      agentsHome: `${ROOT}/agents`,
      cacheHome: `${ROOT}/cache`,
      tempDir: `${ROOT}/tmp`,
      workspace: `${ROOT}/workspace`,
    });
    expect(plan.runtimeBin).not.toContain('//');
  });

  it('falls back to the default root when the configured value is empty', () => {
    expect(buildIsolationPlan({ enabled: true, root: '' }).root).toBe(ISOLATION_ROOT_DEFAULT);
  });

  it('refuses to build an enabled plan from an unsafe root', () => {
    expect(() => buildIsolationPlan({ enabled: true, root: '/srv/a;b' })).toThrow(/invalid-isolation-root/);
    // A disabled plan never reaches the launcher, so nothing is validated there.
    expect(buildIsolationPlan({ enabled: false, root: '/srv/a;b' }).enabled).toBe(false);
  });

  it('uses the isolated workspace for the bare ~ default only', () => {
    const plan = buildIsolationPlan({ enabled: true, root: ROOT });
    expect(resolveLaunchWorkspace('~', plan)).toBe(`${ROOT}/workspace`);
    expect(resolveLaunchWorkspace('~/', plan)).toBe(`${ROOT}/workspace`);
    expect(resolveLaunchWorkspace('~/projects/app', plan)).toBe('~/projects/app');
    expect(resolveLaunchWorkspace('/srv/app', plan)).toBe('/srv/app');
    const off = buildIsolationPlan({ enabled: false, root: ROOT });
    expect(resolveLaunchWorkspace('~', off)).toBe('~');
  });

  it('maps the plan onto the launcher argument', () => {
    const on = buildIsolationPlan({ enabled: true, root: ROOT });
    expect(isolationRootArg(on)).toBe(ROOT);
    const off = buildIsolationPlan({ enabled: false, root: ROOT });
    expect(isolationRootArg(off)).toBe(ISOLATION_DISABLED);
  });
});

describe('launcher environment', () => {
  it('exports every isolation variable inside the distribution', () => {
    for (const line of [
      'export DSH_HOME="$root/dsh-home"',
      'export DSH_AGENTS_HOME="$root/agents"',
      'export XDG_CACHE_HOME="$root/cache"',
      'export TMPDIR="$root/tmp"',
      'export WSL_WEB_SHELL_ISOLATION_ROOT="$root"',
    ]) {
      expect(START_WRAPPER_SCRIPT).toContain(line);
    }
    // The isolated runtime always wins the PATH prefix.
    expect(START_WRAPPER_SCRIPT).toContain('export PATH="$root/runtime/bin:$(dirname "$node"):$PATH"');
  });

  it('expands ~ inside WSL and rejects anything that is not a POSIX path', () => {
    expect(START_WRAPPER_SCRIPT).toContain('[ "$root" != "-" ]');
    expect(START_WRAPPER_SCRIPT).toContain('root="$HOME/${root#"~/"}');
    expect(START_WRAPPER_SCRIPT).toContain('exit 64');
    // Nothing from Windows environment forwarding is trusted.
    expect(START_WRAPPER_SCRIPT).not.toContain('WSLENV');
  });

  it('keeps values out of the script text and passes them as positional arguments', () => {
    const argv = buildStartServerArgs(launchBase);
    expect(argv).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '~',
      '--exec',
      '/bin/bash',
      '-c',
      START_WRAPPER_SCRIPT,
      '/opt/wsl-web-shell/runtime/bin/dsh',
      '127.0.0.1',
      '3080',
      ROOT,
      '/usr/bin/node',
    ]);
    for (const value of [ROOT, '/usr/bin/node', '3080', '/opt/wsl-web-shell/runtime/bin/dsh']) {
      expect(START_WRAPPER_SCRIPT).not.toContain(value);
    }
  });

  it('marks isolation as disabled without any variable setup', () => {
    const argv = buildStartServerArgs({ ...launchBase, isolationRoot: ISOLATION_DISABLED, nodePath: null });
    expect(argv.slice(-2)).toEqual([ISOLATION_DISABLED, ISOLATION_DISABLED]);
  });

  it('rejects unsafe isolation values before any process is spawned', () => {
    for (const isolationRoot of ['/srv/a b', '/srv/../x', 'relative', '/srv/a;id']) {
      expect(() => buildStartServerArgs({ ...launchBase, isolationRoot })).toThrow(ArgumentError);
    }
    for (const nodePath of ['node', '/usr/bin/node -e x', '/usr/../bin/node']) {
      expect(() => buildStartServerArgs({ ...launchBase, nodePath })).toThrow(ArgumentError);
    }
  });

  it('never exposes the launch token or a bind address wider than loopback', () => {
    const argv = buildStartServerArgs(launchBase).join(' ');
    expect(argv).not.toContain('token');
    expect(argv).toContain('--no-open');
    expect(argv).not.toContain('0.0.0.0');
  });
});

describe('environment preparation', () => {
  it('creates only the directories of the plan and nothing else', () => {
    expect(PREPARE_ISOLATION_SCRIPT).toContain('for d in runtime/bin dsh-home agents cache tmp workspace; do mkdir -p "$root/$d"');
    expect(PREPARE_ISOLATION_SCRIPT).toContain('umask 077');
    expect(PREPARE_ISOLATION_SCRIPT).not.toMatch(/\b(apt|dpkg|npm|pnpm|pip|curl|wget|rm|mv|cp)\b/);
    expect(PREPARE_ISOLATION_SCRIPT).not.toContain('sudo');
  });

  it('validates the root before it reaches the shell', () => {
    const argv = buildPrepareIsolationArgs('Ubuntu', ROOT);
    expect(argv).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', PREPARE_ISOLATION_SCRIPT, SCRIPT_ARGV0, ROOT]);
    expect(() => buildPrepareIsolationArgs('Ubuntu', '~/a/../../etc')).toThrow(ArgumentError);
    expect(() => buildPrepareIsolationArgs('Ubuntu', '/srv/a b')).toThrow(ArgumentError);
  });

  it('resolves dsh/node read-only and prefers the isolated runtime', () => {
    const argv = buildResolveRuntimeArgs('Ubuntu', ROOT);
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', RESOLVE_RUNTIME_SCRIPT]);
    expect(argv.at(-1)).toBe(ROOT);
    const isolatedIndex = RESOLVE_RUNTIME_SCRIPT.indexOf('runtime/bin/dsh');
    const systemIndex = RESOLVE_RUNTIME_SCRIPT.indexOf('/usr/local/bin/dsh');
    expect(isolatedIndex).toBeGreaterThan(-1);
    expect(isolatedIndex).toBeLessThan(systemIndex);
    expect(RESOLVE_RUNTIME_SCRIPT).not.toMatch(/\b(apt|apt-get|dpkg|curl|wget|pnpm)\b/);
    expect(RESOLVE_RUNTIME_SCRIPT).not.toMatch(/npm\s+(i|in|install|add)\b/);
  });

  it('parses the runtime probe and drops unsafe values', () => {
    expect(parseRuntimeProbe('dsh=/usr/bin/dsh\nnode=/usr/bin/node\n')).toEqual({
      dshPath: '/usr/bin/dsh',
      nodePath: '/usr/bin/node',
    });
    expect(parseRuntimeProbe('dsh=\nnode=\n')).toEqual({ dshPath: null, nodePath: null });
    expect(parseRuntimeProbe('dsh=relative/dsh\nnode=/usr/../node\n')).toEqual({ dshPath: null, nodePath: null });
    expect(parseRuntimeProbe('garbage\r\ndsh=/opt/dsh\r\n')).toEqual({ dshPath: '/opt/dsh', nodePath: null });
  });
});

describe('supervisor isolation wiring', () => {
  it('prepares the environment and launches with isolation by default', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.runtimeQueries).toEqual([{ isolationRoot: ROOT, override: null }]);
    expect(harness.wsl.isolationPreparations).toEqual([ROOT]);
    expect(harness.wsl.starts[0]).toMatchObject({
      isolationRoot: ROOT,
      nodePath: '/usr/bin/node',
      workspace: `${ROOT}/workspace`,
    });
    // The isolated runtime is prepared before the backend is spawned.
    expect(harness.wsl.isolationPreparations).toHaveLength(1);
    expect(harness.registry.read()).toMatchObject({ workspace: `${ROOT}/workspace` });
  });

  it('keeps an explicitly configured workspace and dsh override', async () => {
    const harness = createHarness({
      config: { workspace: '~/projects/app', dshPath: '/opt/wsl-web-shell/runtime/bin/dsh' },
    });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.runtimeQueries[0]).toEqual({ isolationRoot: ROOT, override: '/opt/wsl-web-shell/runtime/bin/dsh' });
    expect(harness.wsl.starts[0]).toMatchObject({
      workspace: '~/projects/app',
      dshPath: '/opt/wsl-web-shell/runtime/bin/dsh',
      isolationRoot: ROOT,
    });
  });

  it('honours a custom isolation root', async () => {
    const harness = createHarness({ config: { runtimeRoot: '~/r02-sandbox' } });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.isolationPreparations).toEqual(['~/r02-sandbox']);
    expect(harness.wsl.starts[0]).toMatchObject({
      isolationRoot: '~/r02-sandbox',
      workspace: '~/r02-sandbox/workspace',
    });
  });

  it('launches without isolation when the owner disables it', async () => {
    const harness = createHarness({ config: { isolateEnvironment: false } });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();

    expect(harness.wsl.isolationPreparations).toEqual([]);
    expect(harness.wsl.runtimeQueries[0]).toEqual({ isolationRoot: null, override: null });
    expect(harness.wsl.starts[0]).toMatchObject({ isolationRoot: ISOLATION_DISABLED, workspace: '~' });
  });

  it('fails closed when the isolated environment cannot be created', async () => {
    const harness = createHarness({ wsl: { failPrepare: true } });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(lastStatus(harness.statuses).ownedServer).toBe(false);
  });

  it('never starts the backend when dsh is missing inside the isolated runtime', async () => {
    const harness = createHarness({ wsl: { failResolve: 'dsh-missing' } });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
  });
});

describe('isolation configuration', () => {
  it('is enabled by default under the documented root', () => {
    expect(DEFAULT_CONFIG.isolateEnvironment).toBe(true);
    expect(DEFAULT_CONFIG.runtimeRoot).toBe(ISOLATION_ROOT_DEFAULT);
  });

  it('normalizes persisted values and rejects unsafe roots', () => {
    const normalized = normalizeConfig({ isolateEnvironment: 'yes', runtimeRoot: '/srv/a;b' });
    expect(normalized.isolateEnvironment).toBe(true);
    expect(normalized.runtimeRoot).toBe(ISOLATION_ROOT_DEFAULT);

    const off = normalizeConfig({ isolateEnvironment: false, runtimeRoot: '/srv/sandbox' });
    expect(off.isolateEnvironment).toBe(false);
    expect(off.runtimeRoot).toBe('/srv/sandbox');
  });

  it('validates patches field by field', () => {
    const bad = applyConfigPatch(DEFAULT_CONFIG, { isolateEnvironment: 'no' as unknown as boolean, runtimeRoot: '../x' });
    expect(bad.errors).toContain('isolateEnvironment: expected a boolean');
    expect(bad.errors).toContain('runtimeRoot: expected a POSIX path such as ~/.local/share/wsl-web-shell');
    expect(bad.changed).toBe(false);

    const good = applyConfigPatch(DEFAULT_CONFIG, { runtimeRoot: '~/sandbox', isolateEnvironment: true });
    expect(good.errors).toEqual([]);
    expect(good.config.runtimeRoot).toBe('~/sandbox');
    expect(good.changed).toBe(true);
  });

  it('requires a backend restart when the environment changes', () => {
    const next = applyConfigPatch(DEFAULT_CONFIG, { runtimeRoot: '~/other' }).config;
    expect(requiresRestart(DEFAULT_CONFIG, next)).toBe(true);
    expect(requiresRestart(DEFAULT_CONFIG, applyConfigPatch(DEFAULT_CONFIG, { openOnLaunch: false }).config)).toBe(false);
  });
});

const shellAvailable = process.platform !== 'win32' && existsSync('/bin/bash') && existsSync('/bin/sh');

/** Run a launcher script exactly as `wsl.exe --exec /bin/bash -c` would. */
function runScript(script: string, args: string[], home: string) {
  return spawnSync('/bin/bash', ['-c', script, ...args], {
    encoding: 'utf8',
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home },
  });
}

describe.skipIf(!shellAvailable)('launcher scripts execute as designed', () => {
  it('parses without syntax errors', () => {
    for (const script of [START_WRAPPER_SCRIPT, PREPARE_ISOLATION_SCRIPT, RESOLVE_RUNTIME_SCRIPT]) {
      const check = spawnSync('/bin/bash', ['-n', '-c', script], { encoding: 'utf8' });
      expect(check.stderr).toBe('');
      expect(check.status).toBe(0);
    }
  });

  it('prepares exactly the planned directories below a temporary home', () => {
    const home = mkdtempSync(join(tmpdir(), 'wss-prep-'));
    try {
      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const root = join(home, '.local/share/wsl-web-shell');
      expect(readdirSync(root).sort()).toEqual(['agents', 'cache', 'dsh-home', 'runtime', 'tmp', 'workspace']);
      expect(readdirSync(join(root, 'runtime'))).toEqual(['bin']);
      // Nothing outside the root was created.
      expect(readdirSync(home)).toEqual(['.local']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses a non-POSIX root argument without creating anything', () => {
    const home = mkdtempSync(join(tmpdir(), 'wss-prep-bad-'));
    try {
      const result = runScript(PREPARE_ISOLATION_SCRIPT, [SCRIPT_ARGV0, 'relative/root'], home);
      expect(result.status).toBe(64);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('delivers the isolated environment to the backend process', () => {
    const home = mkdtempSync(join(tmpdir(), 'wss-start-'));
    try {
      const stub = join(home, 'dsh-stub');
      writeFileSync(
        stub,
        [
          '#!/bin/sh',
          'printf "DSH_HOME=%s\\n" "$DSH_HOME"',
          'printf "DSH_AGENTS_HOME=%s\\n" "$DSH_AGENTS_HOME"',
          'printf "XDG_CACHE_HOME=%s\\n" "$XDG_CACHE_HOME"',
          'printf "TMPDIR=%s\\n" "$TMPDIR"',
          'printf "ISOLATION_ROOT=%s\\n" "$WSL_WEB_SHELL_ISOLATION_ROOT"',
          'printf "PATH=%s\\n" "$PATH"',
          'printf "ARGS=%s\\n" "$*"',
        ].join('\n'),
      );
      chmodSync(stub, 0o755);

      const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ROOT, '/usr/bin/node'], home);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const root = join(home, '.local/share/wsl-web-shell');
      const lines = result.stdout.trim().split('\n');
      expect(lines[0]).toContain('__dsh_web_shell_pid__');
      const env = Object.fromEntries(lines.slice(1).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
      expect(env.DSH_HOME).toBe(join(root, 'dsh-home'));
      expect(env.DSH_AGENTS_HOME).toBe(join(root, 'agents'));
      expect(env.XDG_CACHE_HOME).toBe(join(root, 'cache'));
      expect(env.TMPDIR).toBe(join(root, 'tmp'));
      expect(env.ISOLATION_ROOT).toBe(root);
      // Isolated runtime first, then the resolved node directory.
      expect(env.PATH?.startsWith(`${join(root, 'runtime/bin')}:/usr/bin:`)).toBe(true);
      // The backend still receives the documented web arguments.
      expect(env.ARGS).toBe('web --host 127.0.0.1 --port 3080 --no-open');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('leaves the environment untouched when isolation is disabled', () => {
    const home = mkdtempSync(join(tmpdir(), 'wss-start-off-'));
    try {
      const stub = join(home, 'dsh-stub');
      writeFileSync(stub, '#!/bin/sh\nprintf "DSH_HOME=%s|ROOT=%s|PATH=%s\\n" "${DSH_HOME:-unset}" "${WSL_WEB_SHELL_ISOLATION_ROOT:-unset}" "$PATH"');
      chmodSync(stub, 0o755);

      const result = runScript(START_WRAPPER_SCRIPT, [stub, '127.0.0.1', '3080', ISOLATION_DISABLED, ISOLATION_DISABLED], home);
      expect(result.status).toBe(0);
      const line = result.stdout.trim().split('\n')[1] ?? '';
      expect(line).toContain('DSH_HOME=unset');
      expect(line).toContain('ROOT=unset');
      expect(line).not.toContain(join(home, '.local'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves the isolated dsh before any system install', () => {
    const home = mkdtempSync(join(tmpdir(), 'wss-resolve-'));
    try {
      const root = join(home, '.local/share/wsl-web-shell');
      const isolatedDsh = join(root, 'runtime/bin/dsh');
      const systemDsh = join(home, '.local/bin/dsh');
      spawnSync('mkdir', ['-p', join(root, 'runtime/bin'), join(home, '.local/bin')]);
      writeFileSync(isolatedDsh, '#!/bin/sh\nexit 0\n');
      writeFileSync(systemDsh, '#!/bin/sh\nexit 0\n');
      chmodSync(isolatedDsh, 0o755);
      chmodSync(systemDsh, 0o755);

      const result = runScript(RESOLVE_RUNTIME_SCRIPT, [SCRIPT_ARGV0, ROOT], home);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`dsh=${isolatedDsh}`);
      // The probe never modifies the filesystem.
      expect(readdirSync(join(home, '.local/bin'))).toEqual(['dsh']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!shellAvailable)('single-argument scripts receive their parameter', () => {
  it('reads the probe argument from $1, not from $0', () => {
    const argv = buildProbeProcessArgs('Ubuntu', process.pid);
    const tail = argv.slice(argv.indexOf(PROBE_PROCESS_SCRIPT) + 1);
    expect(tail).toEqual([SCRIPT_ARGV0, String(process.pid)]);
    // Run the exact script against this very process.
    const result = spawnSync('/bin/sh', ['-c', PROBE_PROCESS_SCRIPT, ...tail], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const probe = parseProcessProbe(result.stdout);
    expect(probe?.startTime).toMatch(/^\d+$/);
    expect(probe?.cmdline.trim().length).toBeGreaterThan(0);
  });

  it('passes the isolation root after the fixed $0 label', () => {
    const argv = buildPrepareIsolationArgs('Ubuntu', ROOT);
    expect(argv.slice(-2)).toEqual([SCRIPT_ARGV0, ROOT]);
    const resolveArgv = buildResolveRuntimeArgs('Ubuntu', ROOT);
    expect(resolveArgv.slice(-2)).toEqual([SCRIPT_ARGV0, ROOT]);
    expect(buildResolveRuntimeArgs('Ubuntu', null).at(-1)).toBe(ISOLATION_DISABLED);
  });
});
