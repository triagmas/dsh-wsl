/**
 * Issue #12 — one-click update: guards, terminal buffer, phase model, runner.
 *
 * Nothing here spawns WSL or npm: the runner is driven through an injected
 * gateway, so every decision can be asserted without touching a real
 * installation.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  UPDATE_REASONS,
  UPDATE_TERMINAL_MAX_LINES,
  createUpdateState,
  createUpdateTerminal,
  describeUpdatePhase,
  describeUpdateReason,
  isExactVersion,
  isInsideIsolatedRuntime,
  isUpdateRunning,
  phaseFromUpdateLine,
  planUpdate,
  sanitizeUpdateLine,
  shouldRestartAfterUpdate,
} from '../src/main/core/update.js';
import { createUpdateRunner } from '../src/main/core/update-runner.js';
import { createNullLogger } from '../src/main/core/logger.js';
import type { NpmVersionCheck, UpdateRunResult, WslGateway } from '../src/main/core/supervisor.js';

const ROOT = '~/.local/share/wsl-web-shell';
const RUNTIME_DSH = `${ROOT.replace('~', '/home/u')}/runtime/bin/dsh`;

function plan(overrides: Partial<Parameters<typeof planUpdate>[0]> = {}) {
  return planUpdate({
    distro: 'Ubuntu',
    targetVersion: '0.2.2-rc.1',
    installedVersion: '0.2.1-rc.5',
    resolvedDshPath: '/home/u/.local/share/wsl-web-shell/runtime/bin/dsh',
    isolationEnabled: true,
    runtimeRoot: ROOT,
    customExecutable: false,
    ...overrides,
  });
}

describe('exact version guard', () => {
  it('accepts plain and pre-release versions', () => {
    expect(isExactVersion('0.2.2')).toBe(true);
    expect(isExactVersion('0.2.2-rc.1')).toBe(true);
    expect(isExactVersion('1.0.0-beta.10')).toBe(true);
  });

  it('rejects ranges, tags and anything a shell could interpret', () => {
    for (const value of ['^0.2.2', '~0.2.2', '>=0.2.2', 'latest', '*', '0.2', '0.2.2 ', '0.2.2; rm -rf /', '0.2.2$(id)', 'v0.2.2', '']) {
      expect(isExactVersion(value), value).toBe(false);
    }
    expect(isExactVersion(undefined)).toBe(false);
    expect(isExactVersion('1'.repeat(60))).toBe(false);
  });
});

describe('terminal buffer', () => {
  it('strips escapes and control characters', () => {
    expect(sanitizeUpdateLine('\u001B[32mupdate: ok\u001B[0m')).toBe('update: ok');
    expect(sanitizeUpdateLine('a\rb\u0007c')).toBe('abc');
  });

  it('drops empty lines', () => {
    expect(sanitizeUpdateLine('   ')).toBeNull();
    expect(sanitizeUpdateLine('\u001B[0m')).toBeNull();
    expect(sanitizeUpdateLine('')).toBeNull();
  });

  it('caps very long output lines', () => {
    const line = sanitizeUpdateLine('x'.repeat(5000));
    expect(line).not.toBeNull();
    expect(line?.length).toBeLessThanOrEqual(320);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('keeps a bounded number of lines', () => {
    const terminal = createUpdateTerminal(3);
    for (let index = 0; index < 10; index += 1) terminal.append(`line ${index}`);
    expect(terminal.lines()).toEqual(['line 7', 'line 8', 'line 9']);
  });

  it('uses the documented default bound', () => {
    const terminal = createUpdateTerminal();
    for (let index = 0; index < UPDATE_TERMINAL_MAX_LINES + 5; index += 1) terminal.append(`line ${index}`);
    expect(terminal.lines()).toHaveLength(UPDATE_TERMINAL_MAX_LINES);
  });
});

describe('isolated runtime detection', () => {
  it('accepts the runtime below a tilde or an absolute root', () => {
    expect(isInsideIsolatedRuntime('/home/u/.local/share/wsl-web-shell/runtime/bin/dsh', ROOT)).toBe(true);
    expect(isInsideIsolatedRuntime('/opt/wss/runtime/bin/dsh', '/opt/wss')).toBe(true);
  });

  it('rejects global, sibling and custom executables', () => {
    expect(isInsideIsolatedRuntime('/usr/local/bin/dsh', ROOT)).toBe(false);
    expect(isInsideIsolatedRuntime('/home/u/.local/share/wsl-web-shell/runtime-other/bin/dsh', ROOT)).toBe(false);
    expect(isInsideIsolatedRuntime('/home/u/.local/share/wsl-web-shell/runtime/bin/dsh', '/opt/wss')).toBe(false);
    expect(isInsideIsolatedRuntime(null, ROOT)).toBe(false);
    expect(isInsideIsolatedRuntime('', ROOT)).toBe(false);
  });
});

describe('update plan guards', () => {
  it('accepts the isolated runtime of the selected distribution', () => {
    const result = plan();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.version).toBe('0.2.2-rc.1');
    expect(result.plan.runtimeDir).toBe(`${ROOT}/runtime`);
    expect(result.plan.previousPattern).toContain('previous-');
  });

  it('refuses a global installation', () => {
    expect(plan({ isolationEnabled: false })).toEqual({ ok: false, reason: UPDATE_REASONS.globalInstallation });
  });

  it('refuses a custom executable pinned in Settings', () => {
    expect(plan({ customExecutable: true })).toEqual({ ok: false, reason: UPDATE_REASONS.customExecutable });
  });

  it('refuses a root that is not a dedicated subtree', () => {
    expect(plan({ runtimeRoot: '~' })).toEqual({ ok: false, reason: UPDATE_REASONS.unsafeRoot });
    expect(plan({ runtimeRoot: '/' })).toEqual({ ok: false, reason: UPDATE_REASONS.unsafeRoot });
  });

  it('refuses when the executable in use is not the isolated one', () => {
    expect(plan({ resolvedDshPath: '/usr/local/bin/dsh' })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.foreignRuntime,
    });
    expect(plan({ resolvedDshPath: `${ROOT}/runtime-other/bin/dsh` })).toEqual({
      ok: false,
      reason: UPDATE_REASONS.foreignRuntime,
    });
    expect(plan({ resolvedDshPath: null })).toEqual({ ok: false, reason: UPDATE_REASONS.foreignRuntime });
  });

  it('refuses an unknown installed version', () => {
    expect(plan({ installedVersion: null })).toEqual({ ok: false, reason: UPDATE_REASONS.unknownInstalled });
    expect(plan({ installedVersion: 'dev' })).toEqual({ ok: false, reason: UPDATE_REASONS.unknownInstalled });
  });

  it('refuses the same or an older version', () => {
    expect(plan({ targetVersion: '0.2.1-rc.5' })).toEqual({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
    expect(plan({ targetVersion: '0.2.0' })).toEqual({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
  });

  it('refuses a version that is not an exact release', () => {
    expect(plan({ targetVersion: '^0.2.2' })).toEqual({ ok: false, reason: UPDATE_REASONS.invalidVersion });
  });

  it('explains every refusal in the confirmation window', () => {
    for (const reason of Object.values(UPDATE_REASONS)) {
      expect(describeUpdateReason(reason).length).toBeGreaterThan(20);
    }
  });
});

describe('phase model', () => {
  it('reports running phases', () => {
    expect(isUpdateRunning('checking')).toBe(true);
    expect(isUpdateRunning('installing')).toBe(true);
    expect(isUpdateRunning('done')).toBe(false);
    expect(isUpdateRunning('failed')).toBe(false);
  });

  it('only relaunches after a completed update', () => {
    expect(shouldRestartAfterUpdate('done')).toBe(true);
    for (const phase of ['idle', 'checking', 'installing', 'verifying', 'activating', 'failed'] as const) {
      expect(shouldRestartAfterUpdate(phase)).toBe(false);
    }
  });

  it('follows the updater step markers', () => {
    expect(phaseFromUpdateLine('update: verifying the staged installation')).toBe('verifying');
    expect(phaseFromUpdateLine('update: activating')).toBe('activating');
    expect(phaseFromUpdateLine('update: done')).toBeNull();
    expect(describeUpdatePhase('failed')).toContain('failed');
  });
});

interface Harness {
  wsl: Pick<WslGateway, 'checkPublishedVersion' | 'installRuntime'>;
  published: string[];
  lines: string[];
  checks: number;
  runs: number;
}

function harness(options: { check?: Partial<NpmVersionCheck>; result?: UpdateRunResult; installLines?: string[] } = {}): Harness {
  const state: Harness = {
    published: [],
    lines: [],
    checks: 0,
    runs: 0,
    wsl: {
      async checkPublishedVersion() {
        state.checks += 1;
        return { found: true, npmPath: '/usr/bin/npm', reported: '0.2.2-rc.1', message: null, ...options.check };
      },
      async installRuntime(_request, onLine) {
        state.runs += 1;
        for (const line of options.installLines ?? ['update: verifying the staged installation', 'update: done']) {
          state.lines.push(line);
          onLine(line);
        }
        return options.result ?? { code: 0, tail: 'update: done' };
      },
    },
  };
  return state;
}

function runner(h: Harness) {
  return createUpdateRunner({
    wsl: h.wsl,
    log: createNullLogger(),
    publish: (state) => h.published.push(state.phase),
    now: () => '2026-01-01T00:00:00.000Z',
  });
}

describe('update runner', () => {
  const accepted = plan();
  if (!accepted.ok) throw new Error('plan must be accepted');

  it('checks npm first, then installs and finishes', async () => {
    const h = harness();
    const outcome = await runner(h).run(accepted.plan, { distro: 'Ubuntu', nodePath: '/home/u/.local/bin/node' });
    expect(outcome.ok).toBe(true);
    expect(h.checks).toBe(1);
    expect(h.runs).toBe(1);
    // Every line republishes the state; only real transitions must show up.
    const transitions = h.published.filter((phase, index) => phase !== h.published[index - 1]);
    expect(transitions).toEqual(['checking', 'installing', 'verifying', 'done']);
    expect(h.lines).toContain('update: verifying the staged installation');
    expect(outcome.state.phase).toBe('done');
    expect(outcome.state.message).toContain('0.2.2-rc.1');
    expect(outcome.state.detail).toContain('previous-');
  });

  it('never installs when npm does not know the version', async () => {
    const h = harness({ check: { found: false, message: 'npm did not report this version.' } });
    const outcome = await runner(h).run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    expect(outcome.ok).toBe(false);
    expect(h.runs).toBe(0);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('npm did not report');
  });

  it('stops when npm is not installed at all', async () => {
    const h = harness({ check: { found: false, npmPath: null, message: 'npm was not found in this distribution.' } });
    const outcome = await runner(h).run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    expect(outcome.ok).toBe(false);
    expect(h.runs).toBe(0);
    expect(outcome.state.detail).toContain('npm was not found');
  });

  it('fails with the updater tail when the install exits non-zero', async () => {
    const h = harness({
      result: { code: 71, tail: 'update: staged version check failed: 0.2.1-rc.5' },
      installLines: ['update: verifying the staged installation', 'update: staged version check failed'],
    });
    const outcome = await runner(h).run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('staged version check failed');
  });

  it('does not run twice at the same time', async () => {
    const h = harness();
    const runnerInstance = runner(h);
    const first = runnerInstance.run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    const second = await runnerInstance.run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    expect(second.ok).toBe(false);
    await expect(first).resolves.toBeTruthy();
    expect(h.runs).toBe(1);
  });

  it('turns a thrown gateway error into a failed state', async () => {
    const h = harness();
    h.wsl.installRuntime = vi.fn().mockRejectedValue(new Error('wsl.exe is missing'));
    const outcome = await runner(h).run(accepted.plan, { distro: 'Ubuntu', nodePath: null });
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(outcome.state.detail).toContain('wsl.exe is missing');
  });

  it('starts from a clean state', () => {
    const state = createUpdateState('2026-01-01T00:00:00.000Z');
    expect(state.phase).toBe('idle');
    expect(state.lines).toEqual([]);
    expect(state.targetVersion).toBeNull();
    // The build-time constant is shared with the WSL script expectations.
    expect(RUNTIME_DSH).toContain('/runtime/bin/dsh');
  });
});
