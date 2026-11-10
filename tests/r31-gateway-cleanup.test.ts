/**
 * Issue #31 / review R02 — the app may only delete a snapshot it provably created,
 * and only once its own process has confirmed that it stopped.
 *
 * Three failure modes are modelled here, all of them invisible to a test whose
 * fake child reports `close` synchronously:
 *
 * 1. `PREPARE_BACKUP_SCRIPT` refuses an already existing `<tx>.tmp` with 79. That
 *    tree is not ours, so no cleanup may run at all.
 * 2. A killed command may keep running for a while. Cleanup must wait for the
 *    owned process to report its exit.
 * 3. A kill may fail, or the exit may never arrive. Then the tree is kept and the
 *    run fails closed instead of deleting something a writer may still fill.
 *
 * A fourth case covers a cleanup that refuses (missing/foreign lease, nested
 * mount, open file): the original failure must survive and the tree must stay.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CLEAN_PROGRESS_MARKER,
  CLEAN_SNAPSHOT_SCRIPT,
  PREPARE_BACKUP_SCRIPT,
} from '../src/main/wsl/update-args.js';
import { WslTimeoutError, createWslGateway } from '../src/main/wsl/gateway.js';
import type { PrepareBackupRequest } from '../src/main/core/supervisor.js';

type Outcome = { code: number; stdout?: string; stderr?: string } | 'hang';

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: string | null;
  kill: () => void;
}

/**
 * A fake `wsl.exe` child.
 *
 * `onKill` decides how the kill behaves: `'exit-now'` closes immediately,
 * `'exit-later'` closes after a delay (a real process takes time to die),
 * `'throw'` makes `kill()` fail, `'never'` never reports an exit at all.
 */
function fakeSpawn(
  plan: (args: string[]) => Outcome,
  onKill: (child: FakeChild, emitClose: (code: number | null) => void) => void,
  events: string[],
) {
  const invocations: string[][] = [];
  const spawnImpl = (_file: string, args: string[]) => {
    invocations.push([...args]);
    events.push(`spawn:${args[5] === CLEAN_SNAPSHOT_SCRIPT ? 'clean' : 'prepare'}`);
    const child = new EventEmitter() as EventEmitter & FakeChild;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const emitClose = (code: number | null) => {
      events.push('close');
      child.stdout.end();
      child.stderr.end();
      child.exitCode = code;
      child.emit('close', code);
    };
    child.kill = () => onKill(child, emitClose);
    const outcome = plan(args);
    setImmediate(() => {
      if (outcome === 'hang') return;
      if (outcome.stdout !== undefined) child.stdout.write(outcome.stdout);
      if (outcome.stderr !== undefined) child.stderr.write(outcome.stderr);
      emitClose(outcome.code);
    });
    return child;
  };
  return { spawnImpl, invocations };
}

const request: PrepareBackupRequest = {
  distro: 'Ubuntu',
  appRoot: '~/root',
  prefix: '/home/dev/.local',
  packageDir: '/home/dev/.local/lib/node_modules/@deepseek-ai/dsh',
  dshPath: '/home/dev/.local/bin/dsh',
  realPath: '/home/dev/.local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  installedVersion: '0.2.1-rc.5',
  transaction: '20261111T090000Z-a1b2',
  nodePath: '/home/dev/.local/bin/node',
};

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const cleanReport = (removed: boolean) =>
  `${CLEAN_PROGRESS_MARKER} 1794318921425 start\n` +
  `${CLEAN_PROGRESS_MARKER} 1794318924400 manifest\n` +
  `__dsh_wsl_clean__ removed=${removed ? 'yes' : 'no'}\n`;

describe('cleanup ownership (review R02 blocker 1)', () => {
  it('does not touch a pre-existing temporary snapshot the script refused with 79', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      () => ({ code: 79, stderr: 'backup: /tmp/x/shared-backup-…tmp already exists\n' }),
      () => {},
      events,
    );
    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe(79);
    expect(attempt.detail).toContain('already exists');
    // No cleanup command at all: the tree was not created by this attempt.
    expect(invocations).toHaveLength(1);
    expect(events).toEqual(['spawn:prepare', 'close']);
  });

  it('does not clean up when the arguments were refused with 64', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      () => ({ code: 64, stderr: 'backup: rejected installed version\n' }),
      () => {},
      events,
    );
    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);
    expect(attempt.ok).toBe(false);
    expect(invocations).toHaveLength(1);
  });

  it('sends a fresh, unpredictable lease with every attempt', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      () => ({ code: 80, stderr: 'backup: the package could not be copied\n' }),
      (_child, emitClose) => emitClose(null),
      events,
    );
    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    await gateway.prepareSharedBackup(request);
    await gateway.prepareSharedBackup(request);

    const leases = invocations
      .filter((args) => args[5] === PREPARE_BACKUP_SCRIPT)
      .map((args) => args[14] ?? '');
    expect(leases).toHaveLength(2);
    for (const lease of leases) expect(lease).toMatch(/^[0-9a-f]{32}$/);
    expect(leases[0]).not.toBe(leases[1]);
    // The cleanup command for the same attempt must carry that attempt's lease.
    const cleanups = invocations.filter((args) => args[5] === CLEAN_SNAPSHOT_SCRIPT);
    expect(cleanups.map((args) => args[8])).toEqual(leases);
  });
});

describe('cleanup waits for a confirmed process exit (review R02 blocker 2)', () => {
  it('starts the cleanup only after the killed command reported its exit', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      (args) => (args[5] === PREPARE_BACKUP_SCRIPT ? 'hang' : { code: 0, stdout: cleanReport(true) }),
      (_child, emitClose) => {
        // A real process takes time to die; the cleanup must wait for this.
        setTimeout(() => emitClose(null), 40);
      },
      events,
    );
    const gateway = createWslGateway({
      spawnImpl,
      log: silentLog,
      timeouts: { backupMs: 10, cleanMs: 1_000, terminationGraceMs: 1_000 },
    } as never);

    await expect(gateway.prepareSharedBackup(request)).rejects.toThrow(/A WSL command timed out/);
    expect(events).toEqual(['spawn:prepare', 'close', 'spawn:clean', 'close']);
    expect(invocations).toHaveLength(2);
  });

  it('keeps the tree and fails closed when the command never confirms its exit', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      () => 'hang',
      () => {
        // The kill does nothing and no close ever arrives.
      },
      events,
    );
    const gateway = createWslGateway({
      spawnImpl,
      log: silentLog,
      timeouts: { backupMs: 10, cleanMs: 1_000, terminationGraceMs: 30 },
    } as never);

    await expect(gateway.prepareSharedBackup(request)).rejects.toThrow(
      /did not confirm its exit.*partial snapshot was kept/,
    );
    expect(invocations).toHaveLength(1);
    expect(events).toEqual(['spawn:prepare']);
  });

  it('keeps the tree when killing the command throws', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      () => 'hang',
      () => {
        throw new Error('kill failed');
      },
      events,
    );
    const gateway = createWslGateway({
      spawnImpl,
      log: silentLog,
      timeouts: { backupMs: 10, cleanMs: 1_000, terminationGraceMs: 30 },
    } as never);

    await expect(gateway.prepareSharedBackup(request)).rejects.toThrow(/did not confirm its exit/);
    expect(invocations).toHaveLength(1);
  });

  it('reports the termination evidence on the error itself', async () => {
    const events: string[] = [];
    const terminated = fakeSpawn(
      () => 'hang',
      (_child, emitClose) => emitClose(null),
      events,
    );
    const killed = createWslGateway({
      spawnImpl: terminated.spawnImpl,
      log: silentLog,
      timeouts: { backupMs: 10, cleanMs: 1_000, terminationGraceMs: 100 },
    } as never);
    await expect(killed.prepareSharedBackup(request)).rejects.toMatchObject({ terminated: true });

    const never = fakeSpawn(
      () => 'hang',
      () => {},
      [],
    );
    const stuck = createWslGateway({
      spawnImpl: never.spawnImpl,
      log: silentLog,
      timeouts: { backupMs: 10, cleanMs: 1_000, terminationGraceMs: 20 },
    } as never);
    await expect(stuck.prepareSharedBackup(request)).rejects.toMatchObject({ terminated: false });
    await expect(stuck.prepareSharedBackup(request)).rejects.toBeInstanceOf(WslTimeoutError);
  });
});

describe('a refused cleanup keeps the tree and the original error', () => {
  it('reports the refusal without hiding the snapshot failure', async () => {
    const events: string[] = [];
    const { spawnImpl, invocations } = fakeSpawn(
      (args) =>
        args[5] === PREPARE_BACKUP_SCRIPT
          ? { code: 80, stderr: 'backup: the content manifest could not be written\n' }
          : { code: 79, stderr: 'clean: the creation lease of /tmp/x belongs to another attempt\n' },
      () => {},
      events,
    );
    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe(80);
    expect(attempt.detail).toBe('backup: the content manifest could not be written');
    expect(invocations).toHaveLength(2);
  });

  it('does not claim a removal when the cleanup refused with 79', async () => {
    const events: string[] = [];
    const { spawnImpl } = fakeSpawn(
      (args) =>
        args[5] === PREPARE_BACKUP_SCRIPT
          ? { code: 80, stderr: 'backup: the content manifest could not be written\n' }
          : { code: 79, stderr: 'clean: /tmp/x is still open by a running process, so it is kept\n' },
      () => {},
      events,
    );
    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    // No phase note: the cleanup produced no report, so nothing is claimed.
    expect(attempt.detail).toBe('backup: the content manifest could not be written');
  });
});
