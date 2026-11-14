/**
 * Issues #12 and #17 — DeepSeek Harness update: guards, terminal buffer, phase
 * model, shared-install journal recovery and the runner transaction.
 *
 * Nothing here spawns WSL or npm: every decision is driven through injected
 * fakes, so all safety rules can be asserted without touching an installation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  UPDATE_REASONS,
  UPDATE_TERMINAL_MAX_LINES,
  createTransactionId,
  createUpdateState,
  createUpdateTerminal,
  decideRecovery,
  BACKUP_REASON_MAX_LENGTH,
  UPDATE_TERMINAL_MAX_LINE_LENGTH,
  backupFailureDetail,
  describeBackupFailure,
  describeUpdatePhase,
  describeUpdateReason,
  isExactVersion,
  isNormalisedAbsolutePath,
  isSameVersion,
  isUpdateCritical,
  isUpdateRunning,
  isValidTransactionId,
  manualUpdateCommand,
  parseUpdateJournal,
  phaseFromUpdateLine,
  planSharedUpdate,
  planTerminalUpdate,
  sanitizeBackupReason,
  sanitizeUpdateLine,
  shouldRefuseQuit,
  shouldRestartAfterUpdate,
  type SharedInstallObservation,
  type SharedUpdatePlanResult,
  type UpdateJournalV2,
  type UpdateJournalStore,
} from '../src/main/core/update.js';
import { describeInstallation, type DshInstallation } from '../src/main/core/dsh-locate.js';
import { createUpdateRunner, type UpdateContext, type UpdateLifecycle } from '../src/main/core/update-runner.js';
import { recoverInterruptedUpdate } from '../src/main/core/update-recovery.js';
import { describeRelaunchFailure, resolveRelaunchTarget } from '../src/main/core/relaunch.js';
import { createNullLogger } from '../src/main/core/logger.js';
import type { UpdateTransition } from '../src/main/core/supervisor.js';
import { DEFAULT_INSTALLATION, FakeWsl } from './helpers.js';

const APP_ROOT = '/home/dev/.local/share/wsl-web-shell';

function installation(overrides: Partial<DshInstallation> = {}): DshInstallation {
  return { ...DEFAULT_INSTALLATION, ...overrides };
}

function planResult(overrides: Partial<Parameters<typeof planSharedUpdate>[0]> = {}): SharedUpdatePlanResult {
  return planSharedUpdate({
    distro: 'Ubuntu',
    targetVersion: '0.2.2-rc.1',
    appRoot: APP_ROOT,
    installation: installation(),
    customExecutable: false,
    ...overrides,
  });
}

function acceptedPlan(overrides: Partial<Parameters<typeof planSharedUpdate>[0]> = {}) {
  const result = planResult(overrides);
  if (!result.ok) throw new Error(`plan must be accepted: ${result.reason}`);
  return result.plan;
}

describe('exact version guard', () => {
  it('accepts plain and pre-release versions', () => {
    expect(isExactVersion('0.2.2')).toBe(true);
    expect(isExactVersion('0.2.2-rc.1')).toBe(true);
    expect(isExactVersion('1.0.0-beta.11')).toBe(true);
  });

  it('rejects ranges, tags and anything a shell could interpret', () => {
    for (const value of ['latest', '^0.2.2', '>=0.2.2', '0.2.2 || 0.3.0', '0.2.2;rm -rf /', '', 'v0.2.2.x', null, 3]) {
      expect(isExactVersion(value)).toBe(false);
    }
  });

  it('never treats a longer version as the shorter one', () => {
    expect(isSameVersion('0.2.2-rc.1', '0.2.2-rc.10')).toBe(false);
    expect(isSameVersion('0.2.2', '0.2.2')).toBe(true);
    expect(isSameVersion('0.2.2', null)).toBe(false);
  });
});

describe('terminal buffer', () => {
  it('strips escapes and control characters', () => {
    expect(sanitizeUpdateLine('\u001B[32madded 1 package\u001B[0m')).toBe('added 1 package');
    expect(sanitizeUpdateLine('line\rwith\rcarriage')).toBe('linewithcarriage');
  });

  it('drops empty lines', () => {
    expect(sanitizeUpdateLine('   ')).toBeNull();
    expect(sanitizeUpdateLine('\u001B[0m')).toBeNull();
  });

  it('caps very long output lines', () => {
    const line = sanitizeUpdateLine('x'.repeat(2_000));
    expect(line).not.toBeNull();
    expect((line ?? '').length).toBeLessThanOrEqual(320);
  });

  it('keeps a bounded number of lines and counts what it dropped', () => {
    const terminal = createUpdateTerminal(3);
    for (let index = 0; index < 5; index += 1) terminal.append(`line ${index}`);
    expect(terminal.lines()).toEqual(['line 2', 'line 3', 'line 4']);
    expect(terminal.dropped()).toBe(2);
  });

  it('uses the documented default bound', () => {
    expect(UPDATE_TERMINAL_MAX_LINES).toBe(400);
  });
});

describe('terminal streaming beyond the rolling cap (review blocker D)', () => {
  it('keeps appending while the buffer still grows', () => {
    const terminal = createUpdateTerminal(3);
    terminal.append('a');
    terminal.append('b');
    const seen = { dropped: 0, rendered: 2 };
    terminal.append('c');
    const plan = planTerminalUpdate({ lines: terminal.lines(), dropped: terminal.dropped() }, seen);
    expect(plan.rebuild).toBe(false);
    expect(plan.append).toEqual(['c']);
  });

  it('asks for a redraw once lines were dropped', () => {
    const terminal = createUpdateTerminal(2);
    for (const line of ['a', 'b', 'c']) terminal.append(line);
    const plan = planTerminalUpdate({ lines: terminal.lines(), dropped: terminal.dropped() }, { dropped: 0, rendered: 2 });
    expect(plan.rebuild).toBe(true);
    expect(plan.append).toEqual(['b', 'c']);
  });
});

describe('path guards', () => {
  it('accepts normalised POSIX paths only', () => {
    expect(isNormalisedAbsolutePath('/home/dev/.npm-global')).toBe(true);
    expect(isNormalisedAbsolutePath('/usr/local')).toBe(true);
    for (const value of ['relative', '/', '/a//b', '/a/./b', '/a/../b', '/a/', 'C:\\bin', null, 42]) {
      expect(isNormalisedAbsolutePath(value)).toBe(false);
    }
  });
});

describe('shared installation update plan (issue #17)', () => {
  it('accepts an npm global installation that is writable and idle', () => {
    const result = planResult();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.dshPath).toBe(DEFAULT_INSTALLATION.path);
    expect(result.plan.prefix).toBe('/home/dev/.npm-global');
    expect(result.plan.packageDir).toBe(DEFAULT_INSTALLATION.packageDir);
    expect(result.plan.scope).toContain('/home/dev/.npm-global');
    expect(result.plan.version).toBe('0.2.2-rc.1');
    expect(result.plan.installedVersion).toBe('0.2.1-rc.5');
  });

  it('refuses a version that is not an exact release', () => {
    expect(planResult({ targetVersion: 'latest' })).toMatchObject({ ok: false, reason: UPDATE_REASONS.invalidVersion });
  });

  it('refuses a custom executable pinned in Settings', () => {
    expect(planResult({ customExecutable: true })).toMatchObject({ ok: false, reason: UPDATE_REASONS.customExecutable });
  });

  it('refuses an unknown installed version', () => {
    expect(planResult({ installation: installation({ version: null }) })).toMatchObject({
      ok: false,
      reason: UPDATE_REASONS.unknownInstalled,
    });
  });

  it('refuses the same or an older version', () => {
    expect(planResult({ targetVersion: '0.2.1-rc.5' })).toMatchObject({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
    expect(planResult({ targetVersion: '0.2.0' })).toMatchObject({ ok: false, reason: UPDATE_REASONS.sameOrOlder });
  });

  it('refuses a manager other than npm', () => {
    for (const manager of ['pnpm', 'unknown'] as const) {
      expect(planResult({ installation: installation({ manager }) })).toMatchObject({
        ok: false,
        reason: UPDATE_REASONS.unsupportedManager,
      });
    }
  });

  it('refuses an executable outside the reported package directory', () => {
    const result = planResult({
      installation: installation({ realPath: '/usr/local/bin/dsh-real' }),
    });
    expect(result).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignRuntime });
  });

  it('refuses a package directory that only shares a prefix with the expected one', () => {
    const result = planResult({
      installation: installation({
        packageDir: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh-old',
        realPath: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh-old/bin/dsh.js',
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignRuntime });
  });

  it('refuses a prefix that needs elevated rights', () => {
    const result = planResult({
      installation: installation({
        prefix: '/usr/local',
        packageDir: '/usr/local/lib/node_modules/@deepseek-ai/dsh',
        realPath: '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
        path: '/usr/local/bin/dsh',
        writable: false,
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: UPDATE_REASONS.notWritable });
    expect(describeUpdateReason(UPDATE_REASONS.notWritable)).toContain('sudo');
  });

  it('refuses when another DSH process uses the installation', () => {
    expect(
      planResult({ installation: installation({ foreignProcesses: 2, foreignPids: [194, 500] }) }),
    ).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignProcess });
  });

  it('allows the attached backend the app can stop itself', () => {
    // An attached backend holds the installation too. Refusing would make the
    // update impossible exactly where it matters, so the one process the app
    // verified it can stop is not counted as "another session".
    const result = planResult({
      installation: installation({ foreignProcesses: 1, foreignPids: [194] }),
      stoppablePid: 194,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.stoppablePid).toBe(194);
  });

  it('still refuses when a second process holds the installation', () => {
    expect(
      planResult({
        installation: installation({ foreignProcesses: 2, foreignPids: [194, 500] }),
        stoppablePid: 194,
      }),
    ).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignProcess, detail: '1' });
  });

  it('refuses when the count is larger than the pid list', () => {
    // A truncated or missing list must never be read as "nobody else is running".
    expect(
      planResult({ installation: installation({ foreignProcesses: 3, foreignPids: [194] }), stoppablePid: 194 }),
    ).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignProcess });
    expect(
      planResult({ installation: installation({ foreignProcesses: 1, foreignPids: [] }) }),
    ).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignProcess });
  });

  it('refuses a backend nobody can stop, even when it is the only holder', () => {
    // No verified manager (hand-started backend): the pid is known, but the app
    // has no right to stop it, so it is a foreign process like any other.
    expect(
      planResult({ installation: installation({ foreignProcesses: 1, foreignPids: [194] }), stoppablePid: null }),
    ).toMatchObject({ ok: false, reason: UPDATE_REASONS.foreignProcess });
  });

  it('refuses when npm is missing', () => {
    expect(planResult({ installation: installation({ npmPath: null }) })).toMatchObject({
      ok: false,
      reason: UPDATE_REASONS.noNpm,
    });
  });

  it('explains every refusal in the confirmation window', () => {
    for (const reason of Object.values(UPDATE_REASONS)) {
      const description = describeUpdateReason(reason);
      expect(description.length).toBeGreaterThan(10);
      expect(description).not.toContain('undefined');
    }
    expect(describeUpdateReason('something-else')).toContain('cannot be started safely');
  });

  it('offers the manual command with the reported prefix', () => {
    expect(manualUpdateCommand({ npmPath: '/usr/bin/npm', prefix: '/usr/local' }, '0.2.2')).toBe(
      '/usr/bin/npm install -g --prefix /usr/local @deepseek-ai/dsh@0.2.2',
    );
    expect(manualUpdateCommand(null, '0.2.2')).toBe('npm install -g @deepseek-ai/dsh@0.2.2');
  });

  it('describes the installation scope for the UI', () => {
    expect(describeInstallation(installation())).toContain('npm');
    expect(describeInstallation(installation())).toContain('0.2.1-rc.5');
  });
});

describe('phase model', () => {
  it('reports running phases', () => {
    for (const phase of ['checking', 'inspecting', 'stopping', 'installing', 'verifying', 'starting'] as const) {
      expect(isUpdateRunning(phase)).toBe(true);
    }
    for (const phase of ['idle', 'done', 'failed', 'rolled-back'] as const) {
      expect(isUpdateRunning(phase)).toBe(false);
    }
  });

  it('refuses to quit while the snapshot or the shared installation is being changed', () => {
    for (const phase of ['inspecting', 'stopping', 'installing', 'verifying', 'starting'] as const) {
      expect(isUpdateCritical(phase)).toBe(true);
      expect(shouldRefuseQuit('user', phase, true)).toBe(true);
    }
    for (const phase of ['idle', 'checking', 'done', 'failed', 'rolled-back'] as const) {
      expect(isUpdateCritical(phase)).toBe(false);
      expect(shouldRefuseQuit('user', phase, true)).toBe(false);
    }
    expect(shouldRefuseQuit('user', 'installing', false)).toBe(false);
  });

  it('never blocks a Windows session end on the update guard', () => {
    // Logoff cannot be refused: blocking only removes the graceful marker and
    // backend stop. The journal covers the interrupted run on the next start.
    for (const phase of ['inspecting', 'stopping', 'installing', 'verifying', 'starting'] as const) {
      expect(shouldRefuseQuit('session-end', phase, true)).toBe(false);
    }
  });

  it('only relaunches after a completed update', () => {
    expect(shouldRestartAfterUpdate('done')).toBe(true);
    for (const phase of ['idle', 'checking', 'inspecting', 'stopping', 'installing', 'verifying', 'starting', 'failed', 'rolled-back'] as const) {
      expect(shouldRestartAfterUpdate(phase)).toBe(false);
    }
  });

  it('follows the updater step markers', () => {
    expect(phaseFromUpdateLine('update: verifying /usr/bin/dsh')).toBe('verifying');
    expect(phaseFromUpdateLine('update: installing @deepseek-ai/dsh@0.2.2')).toBe('installing');
    expect(phaseFromUpdateLine('update: done')).toBeNull();
    expect(describeUpdatePhase('failed')).toContain('failed');
    expect(describeUpdatePhase('rolled-back')).toContain('restored');
  });

  it('starts from an idle state without a target', () => {
    const state = createUpdateState('2026-11-07T10:15:00.000Z');
    expect(state.phase).toBe('idle');
    expect(state.targetVersion).toBeNull();
    expect(state.lines).toEqual([]);
  });
});

// --- transaction journal and recovery --------------------------------------

const journal = (overrides: Partial<UpdateJournalV2> = {}): UpdateJournalV2 => ({
  version: 2,
  kind: 'npm-global',
  transaction: '20261107T101500Z-1a2b',
  phase: 'updating',
  distro: 'Ubuntu',
  dshPath: DEFAULT_INSTALLATION.path,
  realPath: DEFAULT_INSTALLATION.realPath,
  prefix: '/home/dev/.npm-global',
  packageDir: DEFAULT_INSTALLATION.packageDir as string,
  appRoot: APP_ROOT,
  npmPath: '/usr/bin/npm',
  backupDir: `${APP_ROOT}/update/shared-backup-20261107T101500Z-1a2b`,
  target: '0.2.2-rc.1',
  installed: '0.2.1-rc.5',
  startedAt: '2026-11-07T10:15:00.000Z',
  updatedAt: '2026-11-07T10:15:04.000Z',
  ...overrides,
});

const observation = (overrides: Partial<SharedInstallObservation> = {}): SharedInstallObservation => ({
  present: true,
  version: '0.2.1-rc.5',
  realPath: DEFAULT_INSTALLATION.realPath,
  ...overrides,
});

describe('transaction journal', () => {
  it('creates ids that are safe as a path segment and as argv', () => {
    const id = createTransactionId(new Date('2026-11-07T10:15:00.000Z'));
    expect(isValidTransactionId(id)).toBe(true);
    expect(id).toMatch(/^[0-9A-Za-z][0-9A-Za-z-]{7,31}$/);
    expect(isValidTransactionId('short')).toBe(false);
    expect(isValidTransactionId('2026/11/07')).toBe(false);
  });

  it('round-trips a valid journal', () => {
    expect(parseUpdateJournal(journal())).toEqual(journal());
    expect(parseUpdateJournal(journal({ phase: 'verifying' }))?.phase).toBe('verifying');
  });

  it('accepts the home-relative appRoot persisted by real WSL inspections', () => {
    const actual = journal({
      transaction: '20261110T223319Z-0b78',
      appRoot: '~/.local/share/wsl-web-shell',
      backupDir: '/home/triag/.local/share/wsl-web-shell/update/shared-backup-20261110T223319Z-0b78',
    });
    expect(parseUpdateJournal(JSON.parse(JSON.stringify(actual)) as unknown)).toEqual(actual);
    expect(decideRecovery(actual, observation()).action).toBe('abandon');
  });

  it('rejects noncanonical and escaping home-relative app roots', () => {
    for (const appRoot of [
      '~', '~/',
      '~/dir//sub', '~/dir/./sub', '~/dir/../sub', '~/dir/..',
      '~/dir/', '~//dir', '~/dir\\sub', '~/dir\nsub',
      '~/dir\u0000sub', 'relative/home', '~other/.local/share',
    ]) {
      expect(parseUpdateJournal(journal({ appRoot }))).toBeNull();
    }
  });

  it('refuses a journal it cannot trust', () => {
    expect(parseUpdateJournal(null)).toBeNull();
    expect(parseUpdateJournal({})).toBeNull();
    // Wrong kind, unknown phase, non-exact versions, relative paths.
    expect(parseUpdateJournal({ ...journal(), kind: 'other' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), phase: 'activating' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), target: 'latest' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), dshPath: 'relative/dsh' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), prefix: '/' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), appRoot: 'relative' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), npmPath: '' })).toBeNull();
    expect(parseUpdateJournal({ ...journal(), transaction: 'x' })).toBeNull();
  });

  it('still reads a journal written by the retired private-runtime updater', () => {
    const legacy = parseUpdateJournal({
      version: 1,
      transaction: '20261107T101500Z-1a2b',
      phase: 'activating',
      distro: 'Ubuntu',
      runtimeRoot: '~/.local/share/wsl-web-shell',
      canonicalRoot: '/home/u/.local/share/wsl-web-shell',
      target: '0.2.2-rc.1',
      installed: '0.2.1-rc.5',
      startedAt: '2026-11-07T10:15:00.000Z',
      updatedAt: '2026-11-07T10:15:04.000Z',
    });
    expect(legacy?.version).toBe(1);
  });
});

describe('interrupted update recovery decisions', () => {
  it('finalizes when the installation already reports the target', () => {
    expect(decideRecovery(journal(), observation({ version: '0.2.2-rc.1' })).action).toBe('finalize');
  });

  it('abandons a journal whose update never changed the installation', () => {
    expect(decideRecovery(journal(), observation({ version: '0.2.1-rc.5' })).action).toBe('abandon');
  });

  it('rolls back when the installation reports anything else', () => {
    expect(decideRecovery(journal(), observation({ version: '0.2.3' })).action).toBe('rollback');
    expect(decideRecovery(journal(), observation({ version: null })).action).toBe('blocked');
  });

  it('blocks an unreadable version instead of interpreting a failed Node probe as corruption', () => {
    const decision = decideRecovery(journal(), observation({ present: true, version: null }));
    expect(decision.action).toBe('blocked');
    expect(decision.reason).toContain('did not report a verifiable version');
  });

  it('rolls back when the executable is missing', () => {
    const decision = decideRecovery(journal(), observation({ present: false, version: null, realPath: null }));
    expect(decision.action).toBe('rollback');
    expect(decision.reason).toContain('missing');
  });

  it('never accepts a longer pre-release as the target', () => {
    expect(decideRecovery(journal(), observation({ version: '0.2.2-rc.10' })).action).toBe('rollback');
  });

  it('treats a legacy journal as history, not as a pending transaction', () => {
    const legacy = parseUpdateJournal({
      version: 1,
      transaction: '20261107T101500Z-1a2b',
      phase: 'activating',
      distro: 'Ubuntu',
      runtimeRoot: '~/.local/share/wsl-web-shell',
      canonicalRoot: '/home/u/.local/share/wsl-web-shell',
      target: '0.2.2-rc.1',
      installed: '0.2.1-rc.5',
      startedAt: '2026-11-07T10:15:00.000Z',
      updatedAt: '2026-11-07T10:15:04.000Z',
    });
    if (legacy === null) throw new Error('legacy journal must parse');
    expect(decideRecovery(legacy, observation()).action).toBe('legacy');
  });
});

// --- recovery orchestration ------------------------------------------------

function memoryJournal(initial: UpdateJournalV2 | null): UpdateJournalStore & { current(): UpdateJournalV2 | null } {
  let value = initial;
  return {
    read: () => value,
    write: (next) => {
      value = next;
    },
    clear: () => {
      value = null;
    },
    current: () => value,
  };
}

function recoveryHarness(options: { rollbackCode?: number | null; resumeOk?: boolean; legacy?: boolean } = {}) {
  const calls: string[] = [];
  const wsl = new FakeWsl();
  wsl.recoveryObservation = null;
  const resume = async (): Promise<UpdateTransition> => {
    calls.push('resume');
    return { ok: options.resumeOk !== false, message: options.resumeOk === false ? 'backend did not start' : null };
  };
  return { calls, wsl, resume, log: createNullLogger() };
}

describe('recovery orchestration', () => {
  it('does nothing without a journal', async () => {
    const h = recoveryHarness();
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: memoryJournal(null), resume: h.resume, log: h.log });
    expect(result).toEqual({ handled: false, action: null, message: null });
    expect(h.calls).toEqual([]);
  });

  it('abandons a journal whose update never changed the installation', async () => {
    const h = recoveryHarness();
    h.wsl.recoveryObservation = { present: true, version: '0.2.1-rc.5', realPath: DEFAULT_INSTALLATION.realPath };
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('abandon');
    expect(store.current()).toBeNull();
    expect(h.wsl.rollbackRuns).toHaveLength(0);
  });

  it('clears the journal after a successful finalize', async () => {
    const h = recoveryHarness();
    h.wsl.recoveryObservation = { present: true, version: '0.2.2-rc.1', realPath: DEFAULT_INSTALLATION.realPath };
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('finalize');
    expect(store.current()).toBeNull();
  });

  it('reinstalls the previous version and keeps the journal when that fails', async () => {
    const h = recoveryHarness({ resumeOk: false });
    h.wsl.recoveryObservation = { present: true, version: '0.2.2-rc.1', realPath: DEFAULT_INSTALLATION.realPath };
    h.wsl.rollbackCode = 0;
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('blocked');
    expect(h.wsl.rollbackRuns[0]?.version).toBe('0.2.1-rc.5');
    expect(store.current()).not.toBeNull();
  });

  it('reports the exact npm command when the restoration fails', async () => {
    const h = recoveryHarness();
    h.wsl.recoveryObservation = { present: true, version: '0.2.3', realPath: DEFAULT_INSTALLATION.realPath };
    h.wsl.rollbackCode = 74;
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('blocked');
    expect(result.message).toContain('@deepseek-ai/dsh@0.2.1-rc.5');
    expect(store.current()).not.toBeNull();
  });

  it('restores and resumes when the installation reports an unexpected version', async () => {
    const h = recoveryHarness();
    h.wsl.recoveryObservation = { present: true, version: '0.2.3', realPath: DEFAULT_INSTALLATION.realPath };
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('rollback');
    expect(result.message).toContain('0.2.1-rc.5');
    expect(store.current()).toBeNull();
  });

  it('clears a legacy journal instead of misapplying it', async () => {
    const h = recoveryHarness();
    // A v1 record cannot be written by this build, so the store is seeded directly.
    const legacy = parseUpdateJournal({
      version: 1,
      transaction: '20261107T101500Z-1a2b',
      phase: 'activating',
      distro: 'Ubuntu',
      runtimeRoot: '~/.local/share/wsl-web-shell',
      canonicalRoot: '/home/u/.local/share/wsl-web-shell',
      target: '0.2.2-rc.1',
      installed: '0.2.1-rc.5',
      startedAt: '2026-11-07T10:15:00.000Z',
      updatedAt: '2026-11-07T10:15:04.000Z',
    });
    let current: unknown = legacy;
    const result = await recoverInterruptedUpdate({
      wsl: h.wsl,
      journal: {
        read: () => current as never,
        write: (next) => {
          current = next;
        },
        clear: () => {
          current = null;
        },
      },
      resume: h.resume,
      log: h.log,
    });
    expect(result.action).toBe('legacy');
    expect(current).toBeNull();
    expect(result.message).toContain('retired');
  });

  it('blocks when the installation cannot be inspected', async () => {
    const h = recoveryHarness();
    h.wsl.inspectSharedDsh = async () => {
      throw new Error('wsl is not running');
    };
    const store = memoryJournal(journal());
    const result = await recoverInterruptedUpdate({ wsl: h.wsl, journal: store, resume: h.resume, log: h.log });
    expect(result.action).toBe('blocked');
    expect(result.message).toContain('wsl is not running');
    expect(store.current()).not.toBeNull();
  });
});

// --- update runner ---------------------------------------------------------

interface RunnerHarness {
  wsl: FakeWsl;
  lifecycle: UpdateLifecycle;
  journal: UpdateJournalStore & { current(): UpdateJournalV2 | null };
  order: string[];
  published: string[];
  phases: string[];
  runner: ReturnType<typeof createUpdateRunner>;
}

function runnerHarness(
  options: {
    pauseOk?: boolean;
    resumeOk?: boolean;
    rollbackStopOk?: boolean;
    blocker?: string | (() => string | null);
  } = {},
): RunnerHarness {
  const order: string[] = [];
  const published: string[] = [];
  const phases: string[] = [];
  const wsl = new FakeWsl();
  const store = memoryJournal(null);
  const lifecycle: UpdateLifecycle = {
    updateBlocker: async () =>
      typeof options.blocker === 'function' ? options.blocker() : (options.blocker ?? null),
    pauseForUpdate: async () => {
      order.push('pause');
      return { ok: options.pauseOk !== false, message: options.pauseOk === false ? 'port still busy' : null };
    },
    resumeAfterUpdate: async () => {
      order.push('resume');
      return { ok: options.resumeOk !== false, message: options.resumeOk === false ? 'backend did not start' : null };
    },
    stopForRollback: async () => {
      order.push('stop-for-rollback');
      return { ok: options.rollbackStopOk !== false, message: null };
    },
    releaseUpdateLock: () => {
      order.push('release');
    },
    blockForRuntime: (message) => {
      order.push(`blocked:${message}`);
    },
    updateInProgress: true,
  };
  const runner = createUpdateRunner({
    wsl,
    lifecycle,
    journal: store,
    log: createNullLogger(),
    publish: (state) => {
      published.push(state.phase);
      phases.push(state.phase);
    },
    now: () => '2026-11-07T10:15:00.000Z',
  });
  return { wsl, lifecycle, journal: store, order, published, phases, runner };
}

const context: UpdateContext = {
  distro: 'Ubuntu',
  nodePath: '/usr/bin/node',
  transaction: '20261107T101500Z-1a2b',
  customExecutable: false,
  ownPid: 4242,
};

describe('update runner transaction (issue #17)', () => {
  it('refuses before the snapshot when the backend runs outside the app', async () => {
    const h = runnerHarness({
      blocker:
        'The backend serving the WebUI was started outside this app, and an update replaces the files it is running.',
    });
    const outcome = await h.runner.run(acceptedPlan(), context);

    expect(outcome.ok).toBe(false);
    expect(outcome.state.detail).toContain('started outside this app');
    // Nothing was read from npm, nothing was copied, nothing was written.
    expect(h.wsl.prunedSnapshots).toHaveLength(0);
    expect(h.wsl.backupRequests).toHaveLength(0);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.journal.current()).toBeNull();
    expect(h.order).toEqual([]);
  });

  it('does not leave the runner busy after a refusal', async () => {
    let blocked: string | null = 'The backend serving the WebUI was started outside this app.';
    const h = runnerHarness({ blocker: () => blocked });

    const refused = await h.runner.run(acceptedPlan(), context);
    expect(refused.ok).toBe(false);
    // A refusal that never started must not claim the runner: the next attempt has
    // to be accepted as soon as the owner clears the obstacle.
    expect(h.runner.running()).toBe(false);

    blocked = null;
    const second = await h.runner.run(acceptedPlan(), context);
    expect(second.ok).toBe(true);
  });

  it('prunes old recovery snapshots after the new one is verified', async () => {
    const h = runnerHarness();
    h.wsl.pruneRemoved = ['/home/dev/.local/share/wsl-web-shell/update/shared-backup-old'];
    const outcome = await h.runner.run(acceptedPlan(), context);

    expect(outcome.ok).toBe(true);
    expect(h.wsl.prunedSnapshots).toHaveLength(1);
    expect(h.wsl.prunedSnapshots[0]?.keep).toBe(2);
  });

  it('inspects, stops the owned backend, updates, verifies and only then reports done', async () => {
    const h = runnerHarness();
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(true);
    // Nothing is written before the backend was stopped.
    expect(h.order).toEqual(['pause', 'resume']);
    expect(h.journal.current()).toBeNull();
    expect(h.wsl.updateRuns).toHaveLength(1);
    expect(h.wsl.updateRuns[0]?.prefix).toBe('/home/dev/.npm-global');
    expect(h.wsl.updateRuns[0]?.version).toBe('0.2.2-rc.1');
    expect(h.wsl.updateRuns[0]?.ownPid).toBe(4242);
    // The journal is written before the install and cleared only after success.
    const phases = h.published.filter((phase, index) => phase !== h.published[index - 1]);
    expect(phases).toEqual(['checking', 'inspecting', 'stopping', 'installing', 'verifying', 'starting', 'done']);
    expect(outcome.state.detail).toContain('/home/dev/.npm-global/bin/dsh');
  });

  it('never installs when npm does not know the version', async () => {
    const h = runnerHarness();
    h.wsl.npmCheckResult = { found: false, npmPath: '/usr/bin/npm', reported: '0.2.2-rc.1', message: 'npm did not report this version.' };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.journal.current()).toBeNull();
  });

  it('stops before installing when npm is missing', async () => {
    const h = runnerHarness();
    h.wsl.npmCheckResult = { found: false, npmPath: null, reported: null, message: 'npm was not found in this distribution.' };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.order).toEqual([]);
    expect(outcome.state.detail).toContain('npm');
  });

  it('re-validates the installation and refuses a changed prefix before writing', async () => {
    const h = runnerHarness();
    h.wsl.installation = { ...h.wsl.installation, writable: false, prefix: '/usr/local', packageDir: '/usr/local/lib/node_modules/@deepseek-ai/dsh', realPath: '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js', path: '/usr/local/bin/dsh' };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.order).toEqual([]);
    expect(outcome.state.detail).toContain('sudo');
  });

  it('refuses when another DSH process appears between plan and install', async () => {
    const h = runnerHarness();
    h.wsl.installation = { ...h.wsl.installation, foreignProcesses: 1 };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(outcome.state.detail).toContain('DeepSeek Harness process is running');
  });

  it('keeps the running backend when it cannot be stopped', async () => {
    const h = runnerHarness({ pauseOk: false });
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.journal.current()).toBeNull();
    expect(h.order).toContain('release');
  });

  it('reinstalls the previous version when npm cannot install the new one', async () => {
    const h = runnerHarness();
    h.wsl.updateCode = 72;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('rolled-back');
    expect(h.wsl.rollbackRuns[0]?.version).toBe('0.2.1-rc.5');
    expect(h.journal.current()).toBeNull();
    // The unit this update started is stopped before the previous files are restored.
    expect(h.order).toEqual(['pause', 'stop-for-rollback', 'resume']);
  });

  it('abandons the rollback instead of writing under a running unit', async () => {
    const h = runnerHarness({ rollbackStopOk: false });
    h.wsl.updateCode = 71;
    const outcome = await h.runner.run(acceptedPlan(), context);

    expect(outcome.ok).toBe(false);
    // Nothing is written: the previous files would be replaced under a process
    // that is still executing them.
    expect(h.wsl.rollbackRuns).toHaveLength(0);
    expect(h.journal.current()).not.toBeNull();
    expect(h.order.some((entry) => entry.startsWith('blocked:'))).toBe(true);
  });

  it('blocks further starts when the rollback itself failed', async () => {
    const h = runnerHarness();
    h.wsl.updateCode = 73;
    h.wsl.rollbackCode = 74;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('failed');
    expect(h.journal.current()).not.toBeNull();
    expect(h.order.some((entry) => entry.startsWith('blocked:'))).toBe(true);
  });

  it('verifies the version independently and rolls back when it is wrong', async () => {
    const h = runnerHarness();
    // npm claimed success but the executable still reports the old version.
    h.wsl.installationAfterUpdate = { version: '0.2.1-rc.5' };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).toBe('rolled-back');
    expect(h.wsl.rollbackRuns).toHaveLength(1);
    expect(h.journal.current()).toBeNull();
  });

  it('rolls back when the updated version does not start', async () => {
    const h = runnerHarness({ resumeOk: false });
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.rollbackRuns[0]?.version).toBe('0.2.1-rc.5');
    expect(h.journal.current()).not.toBeNull();
  });

  it('refuses to run twice at the same time', async () => {
    const h = runnerHarness();
    const first = h.runner.run(acceptedPlan(), context);
    const second = await h.runner.run(acceptedPlan(), context);
    expect(second.ok).toBe(false);
    await first;
    expect(h.wsl.updateRuns).toHaveLength(1);
  });

  it('keeps a journal that could not be written from touching anything', async () => {
    const h = runnerHarness();
    const failing: UpdateJournalStore & { current(): UpdateJournalV2 | null } = {
      read: () => null,
      write: () => {
        throw new Error('EACCES: permission denied');
      },
      clear: () => undefined,
      current: () => null,
    };
    const runner = createUpdateRunner({
      wsl: h.wsl,
      lifecycle: h.lifecycle,
      journal: failing,
      log: createNullLogger(),
      publish: () => undefined,
      now: () => '2026-11-07T10:15:00.000Z',
    });
    const outcome = await runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.order).toEqual([]);
  });
});

describe('relaunch target after an update (issues #12 and #14)', () => {
  const portable = 'D:\\Apps\\DSH-WSL-0.1.0-x64-Portable.exe';
  const installed = 'C:\\Users\\me\\AppData\\Local\\Programs\\DSH WSL\\DSH WSL.exe';
  const installedResources = 'C:\\Users\\me\\AppData\\Local\\Programs\\DSH WSL\\resources';
  const installedEnv = {
    portableExecutableFile: null as string | null,
    execPath: installed,
    platform: 'win32',
    packaged: true,
    resourcesPath: installedResources,
  };

  it('relaunches the portable executable, not the extraction copy', () => {
    const decision = resolveRelaunchTarget(
      {
        portableExecutableFile: portable,
        execPath: 'C:\\Temp\\2abc\\DSH WSL.exe',
        platform: 'win32',
        packaged: true,
        resourcesPath: 'C:\\Temp\\2abc\\resources',
      },
      (path) => path === portable,
    );
    expect(decision).toEqual({ ok: true, target: { execPath: portable, mode: 'portable', portable: true } });
  });

  it('relaunches the installed executable itself', () => {
    const decision = resolveRelaunchTarget(installedEnv, (path) => path === installed || path.endsWith('app.asar'));
    expect(decision).toEqual({ ok: true, target: { execPath: installed, mode: 'installed', portable: false } });
  });

  it('accepts the installed payload with forward slashes as electron-builder reports them', () => {
    const decision = resolveRelaunchTarget(
      { ...installedEnv, resourcesPath: 'C:/Users/me/AppData/Local/Programs/DSH WSL/resources' },
      (path) => path === installed || path.endsWith('app.asar'),
    );
    expect(decision.ok).toBe(true);
  });

  it('refuses a development run and an installation it cannot prove', () => {
    // electron . — there is no packaged payload, so nothing may be restarted.
    expect(
      resolveRelaunchTarget(
        {
          portableExecutableFile: null,
          execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe',
          platform: 'win32',
          packaged: false,
          resourcesPath: 'C:\\repo\\node_modules\\electron\\dist\\resources',
        },
        () => true,
      ),
    ).toEqual({ ok: false, reason: 'dev-unpackaged' });
    // Packaged, but the executable is gone.
    expect(resolveRelaunchTarget(installedEnv, (path) => path.endsWith('app.asar'))).toEqual({
      ok: false,
      reason: 'installed-not-a-file',
    });
    // Packaged, but the resources do not belong to this executable.
    expect(
      resolveRelaunchTarget(
        { ...installedEnv, resourcesPath: 'C:\\Temp\\2abc\\resources' },
        () => true,
      ),
    ).toEqual({ ok: false, reason: 'installed-ambiguous' });
    // Packaged, resources match, but there is no packaged payload next to the EXE.
    expect(resolveRelaunchTarget(installedEnv, (path) => path === installed)).toEqual({
      ok: false,
      reason: 'installed-ambiguous',
    });
  });

  it('refuses to guess when the app was not started from the portable EXE', () => {
    expect(
      resolveRelaunchTarget(
        {
          portableExecutableFile: 'C:\\gone\\app.exe',
          execPath: 'C:\\dev\\electron.exe',
          platform: 'win32',
          packaged: true,
          resourcesPath: 'C:\\dev\\resources',
        },
        () => false,
      ),
    ).toEqual({ ok: false, reason: 'portable-not-a-file' });
    expect(
      resolveRelaunchTarget(
        {
          portableExecutableFile: 'C:\\temp\\x.txt',
          execPath: 'C:\\dev\\electron.exe',
          platform: 'win32',
          packaged: true,
          resourcesPath: 'C:\\dev\\resources',
        },
        () => true,
      ),
    ).toEqual({ ok: false, reason: 'portable-not-a-file' });
  });

  it('never relaunches outside Windows', () => {
    expect(resolveRelaunchTarget({ ...installedEnv, platform: 'linux' }, () => true)).toEqual({
      ok: false,
      reason: 'not-windows',
    });
  });

  it('explains every refused relaunch to the user', () => {
    for (const reason of [
      'portable-not-a-file',
      'dev-unpackaged',
      'installed-not-a-file',
      'installed-ambiguous',
      'not-windows',
    ] as const) {
      expect(describeRelaunchFailure(reason).length).toBeGreaterThan(40);
    }
  });
});

// --- wiring invariants -----------------------------------------------------

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

describe('update window and shutdown wiring (review blocker D)', () => {
  const windowsSource = read('src/main/electron/windows.ts');
  const indexSource = read('src/main/index.ts');
  const progressSource = read('src/update/progress.js');

  it('keeps the terminal window unclosable while the run is active', () => {
    expect(windowsSource).toContain('setClosable(false)');
    expect(windowsSource).toContain('setClosable(!running)');
    expect(windowsSource).toContain("window.on('close', (event) => {");
    expect(windowsSource).toContain('event.preventDefault()');
    expect(windowsSource).toContain('isUpdateRunning(');
  });

  it('refuses to quit while the runtime is being replaced', () => {
    expect(indexSource).toContain('quit refused: the update is');
    expect(indexSource).toContain('isUpdateCritical(');
    // Only the read-only npm version check may be interrupted, and it is logged.
    expect(indexSource).toContain('quit during update check');
  });

  it('rebuilds the terminal once the rolling cap starts dropping lines', () => {
    expect(progressSource).toContain('state.dropped');
    expect(progressSource).toContain('writeLines(lines)');
    expect(progressSource).toContain('lines.slice(rendered)');
  });

  it('never relaunches an unknown executable', () => {
    expect(indexSource).toContain('resolveRelaunchTarget(');
    expect(indexSource).toContain('describeRelaunchFailure(');
    expect(indexSource).toContain('PORTABLE_EXECUTABLE_FILE');
    // Both packages are proven before a relaunch: the portable origin and the
    // installed payload (issue #14).
    expect(indexSource).toContain('packaged: app.isPackaged');
    expect(indexSource).toContain('resourcesPath: process.resourcesPath');
    // The old unconditional relaunch is gone.
    expect(indexSource).not.toContain('app.relaunch(portable === null ? {}');
  });
});

// --- B1/B2/B3: the blocking review of PR #18 -------------------------------

describe('recovery snapshot and identity checks (review B1-B3)', () => {
  it('creates the verified snapshot before anything is stopped or installed', async () => {
    const h = runnerHarness();
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(true);
    // The snapshot is requested before the backend is paused and carries the
    // pinned identity of the installation that is about to change.
    expect(h.wsl.backupRequests).toHaveLength(1);
    const backup = h.wsl.backupRequests[0];
    expect(backup?.realPath).toBe(DEFAULT_INSTALLATION.realPath);
    expect(backup?.packageDir).toBe(DEFAULT_INSTALLATION.packageDir);
    expect(backup?.transaction).toBe(context.transaction);
    expect(h.order).toEqual(['pause', 'resume']);
    // The installation is only touched with that snapshot.
    expect(h.wsl.updateRuns[0]?.snapshotDir).toContain(`/update/shared-backup-${context.transaction}`);
    expect(h.wsl.updateRuns[0]?.realPath).toBe(DEFAULT_INSTALLATION.realPath);
  });

  it('never stops the backend or installs when the snapshot cannot be verified', async () => {
    const h = runnerHarness();
    h.wsl.backupFails = true;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    // B1: fail closed *before* the installation and before the backend is paused.
    expect(h.order).toEqual([]);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.journal.current()).toBeNull();
    expect(outcome.state.detail).toContain('verified recovery snapshot');
  });

  it('hands the resolved Node runtime to the snapshot step (issue #27)', async () => {
    const h = runnerHarness();
    await h.runner.run(acceptedPlan(), { ...context, nodePath: '/home/dev/.local/bin/node' });
    // The npm launcher is a `#!/usr/bin/env node` shim: the backup script needs
    // the runtime directory on PATH, and asking for it here keeps that
    // independent of the isolation switch.
    expect(h.wsl.backupRequests[0]?.nodePath).toBe('/home/dev/.local/bin/node');
  });

  it('reports an unknown runtime as `null` rather than guessing a path', async () => {
    const h = runnerHarness();
    await h.runner.run(acceptedPlan(), { ...context, nodePath: null });
    expect(h.wsl.backupRequests[0]?.nodePath).toBeNull();
  });

  it('surfaces the real backup failure instead of generic free-space advice', async () => {
    const h = runnerHarness();
    h.wsl.backupFails = true;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    const detail = outcome.state.detail ?? '';
    expect(detail).toContain('exit code 81');
    expect(detail).toContain('reports [] instead of [0.2.1-rc.5]');
    expect(detail).toContain('nothing was changed');
    expect(detail).not.toContain('free space');
    // Fail closed: no backend pause, no install, no journal record.
    expect(h.order).toEqual([]);
    expect(h.wsl.updateRuns).toHaveLength(0);
    expect(h.journal.current()).toBeNull();
  });

  it('writes the exit status and the script line into the terminal buffer', async () => {
    const h = runnerHarness();
    h.wsl.backupFails = true;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    const lines = (outcome.state.lines ?? []).join('\n');
    expect(lines).toContain('update: the recovery snapshot failed (code=81)');
    expect(lines).toContain('reports [] instead of [0.2.1-rc.5]');
    // The step is announced before it runs, so the window never shows an
    // unexplained stop.
    expect(lines).toContain('update: preparing a recovery snapshot of');
  });

  it('describes a snapshot failure with whatever the script reported', () => {
    expect(describeBackupFailure(81, 'backup: /home/dev/.local/bin/dsh reports [] instead of [0.2.1-rc.5]'))
      .toBe(
        'The verified recovery snapshot could not be created (exit code 81: backup: /home/dev/.local/bin/dsh reports [] instead of [0.2.1-rc.5]), so nothing was changed. Your DeepSeek Harness CLI was not modified.',
      );
    expect(describeBackupFailure(null, '')).toContain('no exit status');
    expect(describeBackupFailure(null, '')).toContain('printed no explanation');
    expect(describeBackupFailure(null, null)).toContain('printed no explanation');
    expect(describeBackupFailure(80, 'the snapshot failed its integrity check')).toContain('exit code 80');
  });

  it('takes the last stderr line through the sanitizer at the gateway boundary', () => {
    const token = 'c'.repeat(48);
    const detail = backupFailureDetail(
      'progress noise\n',
      `update: copying\nbackup: \u001b[31mdsh reports [] instead of [0.2.1-rc.5]\u001b[0m ?token=${token}\n\n`,
    );
    expect(detail).not.toContain(token);
    expect(detail).toContain('token=[redacted]');
    expect(detail).toMatch(/^[\x20-\x7e\u2026]+$/);
    // The actionable part survives; only the credential is replaced.
    expect(detail).toContain('reports [] instead of [0.2.1-rc.5]');
    // stderr is preferred, stdout is the fallback, silence stays silent.
    expect(backupFailureDetail('backup: from stdout', '')).toBe('backup: from stdout');
    expect(backupFailureDetail('', '')).toBe('');
    expect(backupFailureDetail('\u001b[2J', '\u0007')).toBe('');
  });

  it('bounds a very long gateway detail', () => {
    const detail = backupFailureDetail('', `${'z'.repeat(9000)}\n`);
    expect(detail.length).toBeLessThanOrEqual(UPDATE_TERMINAL_MAX_LINE_LENGTH);
    expect(detail.endsWith('\u2026')).toBe(true);
  });

  it('redacts credentials, strips escapes and bounds the reason it receives', () => {
    const token = 'a'.repeat(32);
    const reason = sanitizeBackupReason(`backup: \u001b[31mfailed\u001b[0m\u0007 https://127.0.0.1:3080/?token=${token} rest`);
    expect(reason).not.toBeNull();
    expect(reason).not.toContain(token);
    expect(reason).toContain('token=[redacted]');
    // Printable only: no escape, no bell, no carriage return.
    expect(reason).toMatch(/^[\x20-\x7e\u2026]+$/);
    expect(reason).toContain('failed');
  });

  it('caps a long backup reason instead of forwarding it whole', () => {
    const long = `backup: ${'x'.repeat(5000)}`;
    const reason = sanitizeBackupReason(long);
    expect(reason).not.toBeNull();
    expect(reason?.length ?? 0).toBeLessThanOrEqual(BACKUP_REASON_MAX_LENGTH);
    expect(reason?.endsWith('\u2026')).toBe(true);
  });

  it('collapses a multi-line reason and rejects output with nothing visible', () => {
    expect(sanitizeBackupReason('  backup: a\n\tb  ')).toBe('backup: a b');
    expect(sanitizeBackupReason('\u001b[2J\u0007  ')).toBeNull();
    expect(sanitizeBackupReason('')).toBeNull();
  });

  it('keeps token-bearing, escape-laden and very long stderr out of every surface', async () => {
    const h = runnerHarness();
    h.wsl.backupFails = true;
    const token = 'b'.repeat(40);
    h.wsl.backupFailureDetail = `backup: \u001b[1;31midentity check failed\u001b[0m token=${token} ${'y'.repeat(2000)}`;
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);

    const detail = outcome.state.detail ?? '';
    const lines = (outcome.state.lines ?? []).join('\n');
    for (const surface of [detail, lines]) {
      expect(surface).not.toContain(token);
      expect(surface).not.toContain('\u001b');
      expect(surface).not.toContain('\u0007');
      expect(surface).toContain('identity check failed');
    }
    // The exit code and the actionable reason survive, the message stays bounded.
    expect(detail).toContain('exit code 81');
    expect(detail).toContain('nothing was changed');
    expect(detail.length).toBeLessThanOrEqual(400);
    expect(lines.length).toBeLessThan(1000);
  });

  it('records the snapshot in the journal so recovery can use it offline', async () => {
    const h = runnerHarness();
    const written: UpdateJournalV2[] = [];
    const store = h.journal;
    const original = store.write.bind(store);
    store.write = (next: UpdateJournalV2) => {
      written.push(next);
      original(next);
    };
    await h.runner.run(acceptedPlan(), context);
    expect(written.length).toBeGreaterThan(0);
    expect(written[0]?.backupDir).toContain(`/update/shared-backup-${context.transaction}`);
    expect(written[0]?.realPath).toBe(DEFAULT_INSTALLATION.realPath);
    // Success cleared the record; the snapshot path was never guessed.
    expect(h.journal.current()).toBeNull();
  });

  it('treats a fail-closed updater code as "nothing changed" and keeps the installation', async () => {
    for (const code of [79, 80, 81, 82]) {
      const h = runnerHarness();
      h.wsl.updateCode = code;
      h.wsl.updateRunLines = ['update: the installation identity changed, so nothing was changed'];
      const outcome = await h.runner.run(acceptedPlan(), context);
      expect(outcome.ok).toBe(false);
      expect(h.wsl.rollbackRuns).toHaveLength(0);
      expect(h.journal.current()).toBeNull();
      expect(h.order).toEqual(['pause', 'resume']);
      expect(outcome.state.detail).toContain('Nothing was changed');
    }
  });

  it('rolls back when the installation did not stay at the approved path', async () => {
    const h = runnerHarness();
    h.wsl.installationAfterUpdate = {
      version: '0.2.2-rc.1',
      loginShellVersion: '0.2.2-rc.1',
      realPath: '/home/dev/other/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.rollbackRuns).toHaveLength(1);
    expect(h.wsl.rollbackRuns[0]?.request.snapshotDir).toContain('/update/shared-backup-');
    expect(h.wsl.rollbackRuns[0]?.request.realPath).toBe(DEFAULT_INSTALLATION.realPath);
  });

  it('rolls back when a login shell does not run the updated version', async () => {
    const h = runnerHarness();
    h.wsl.installationAfterUpdate = {
      version: '0.2.2-rc.1',
      loginShellVersion: '0.2.1-rc.5',
      loginShellRealPath: '/home/dev/other/bin/dsh',
    };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(h.wsl.rollbackRuns).toHaveLength(1);
    expect(outcome.state.phase).not.toBe('done');
    expect(outcome.state.detail).toContain('login shell');
  });

  it('refuses a plan when a login shell cannot resolve the installation at all (C1)', () => {
    for (const overrides of [
      { loginShellRealPath: null },
      { loginShellRealPath: null, loginShellVersion: null },
      { loginShellVersion: null },
      { loginShellVersion: '0.2.0' },
    ]) {
      const result = planSharedUpdate({
        distro: 'Ubuntu',
        targetVersion: '0.2.2-rc.1',
        appRoot: '/home/dev/.local/share/wsl-web-shell',
        installation: { ...DEFAULT_INSTALLATION, ...overrides },
        customExecutable: false,
      });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe('login-shell-mismatch');
    }
  });

  it('rolls back when the login shell becomes unresolvable after the update (C1)', async () => {
    const h = runnerHarness();
    h.wsl.installationAfterUpdate = {
      version: '0.2.2-rc.1',
      loginShellRealPath: null,
      loginShellVersion: null,
    };
    const outcome = await h.runner.run(acceptedPlan(), context);
    expect(outcome.ok).toBe(false);
    expect(outcome.state.phase).not.toBe('done');
    expect(h.wsl.rollbackRuns).toHaveLength(1);
    expect(h.journal.current()).toBeNull();
  });

  it('refuses a plan when the login shell resolves another installation', () => {
    const result = planSharedUpdate({
      distro: 'Ubuntu',
      targetVersion: '0.2.2-rc.1',
      appRoot: '/home/dev/.local/share/wsl-web-shell',
      installation: { ...DEFAULT_INSTALLATION, loginShellRealPath: '/home/dev/other/bin/dsh' },
      customExecutable: false,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('login-shell-mismatch');
  });

  it('rolls back when a crash leaves the installation at the target version but another path', () => {
    const decision = decideRecovery(
      journal(),
      { present: true, version: '0.2.2-rc.1', realPath: '/home/dev/elsewhere/bin/dsh.js' },
    );
    expect(decision.action).toBe('rollback');
  });
});
