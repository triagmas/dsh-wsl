/**
 * Issue #31 — a killed snapshot attempt is finished by the app, and the failure
 * names the phase that was still running.
 *
 * The gateway is driven with a fake `spawn` so the two commands it issues can be
 * inspected: the snapshot command fails as if its budget had expired, and the
 * cleanup command reports the phase markers it reprinted. Nothing here touches
 * WSL, the file system or a user installation.
 */
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CLEAN_PROGRESS_MARKER, CLEAN_SNAPSHOT_SCRIPT, PREPARE_BACKUP_SCRIPT } from '../src/main/wsl/update-args.js';
import { createWslGateway } from '../src/main/wsl/gateway.js';
import type { PrepareBackupRequest } from '../src/main/core/supervisor.js';

interface Invocation {
  args: string[];
}

type Outcome = { code: number; stdout?: string; stderr?: string } | 'hang';

/**
 * Minimal child process: piped output, a close event and a kill that ends it.
 *
 * `'hang'` models a command that never finishes, so the gateway's own budget is
 * what ends it — the case that produced the orphaned 863 MB tree in R26C.
 */
function fakeSpawn(plan: (args: string[]) => Outcome) {
  const invocations: Invocation[] = [];
  const spawnImpl = (file: string, args: string[]) => {
    invocations.push({ args: [...args] });
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: string | null;
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.signalCode = 'SIGTERM';
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null);
    };
    const outcome = plan(args);
    setImmediate(() => {
      if (outcome === 'hang') return;
      if (outcome.stdout !== undefined) child.stdout.write(outcome.stdout);
      if (outcome.stderr !== undefined) child.stderr.write(outcome.stderr);
      child.stdout.end();
      child.stderr.end();
      child.exitCode = outcome.code;
      child.emit('close', outcome.code);
    });
    void file;
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

describe('an interrupted snapshot is cleaned up and its phase is reported', () => {
  it('runs the cleanup command and appends the phase that was running', async () => {
    const { spawnImpl, invocations } = fakeSpawn((args) => {
      const script = args[5] ?? '';
      if (script === PREPARE_BACKUP_SCRIPT) {
        return { code: 80, stderr: 'backup: the content manifest could not be written\n' };
      }
      if (script === CLEAN_SNAPSHOT_SCRIPT) {
        return {
          code: 0,
          stdout:
            `${CLEAN_PROGRESS_MARKER} 1794318921425 start\n` +
            `${CLEAN_PROGRESS_MARKER} 1794318922984 copy\n` +
            `${CLEAN_PROGRESS_MARKER} 1794318924400 manifest\n` +
            '__dsh_wsl_clean__ removed=yes\n',
        };
      }
      return { code: 1, stderr: 'unexpected command\n' };
    });

    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe(80);
    expect(attempt.detail).toContain('the content manifest could not be written');
    expect(attempt.detail).toContain('stopped during: manifest');

    expect(invocations).toHaveLength(2);
    const cleanup = invocations[1]?.args ?? [];
    expect(cleanup[5]).toBe(CLEAN_SNAPSHOT_SCRIPT);
    expect(cleanup.slice(6)).toEqual(['~/root', '20261111T090000Z-a1b2']);
  });

  it('cleans up even when the snapshot command is killed by its budget', async () => {
    const { spawnImpl, invocations } = fakeSpawn((args) => {
      const script = args[5] ?? '';
      if (script === PREPARE_BACKUP_SCRIPT) return 'hang';
      if (script === CLEAN_SNAPSHOT_SCRIPT) {
        return {
          code: 0,
          stdout: `${CLEAN_PROGRESS_MARKER} 1794318921425 start\n${CLEAN_PROGRESS_MARKER} 1794318924400 manifest\n__dsh_wsl_clean__ removed=yes\n`,
        };
      }
      return { code: 1, stderr: 'unexpected command\n' };
    });

    const gateway = createWslGateway({ spawnImpl, log: silentLog, timeouts: { backupMs: 20, cleanMs: 200 } } as never);
    await expect(gateway.prepareSharedBackup(request)).rejects.toThrow(/A WSL command timed out.*stopped during: manifest/);
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.args[5]).toBe(CLEAN_SNAPSHOT_SCRIPT);
  });

  it('keeps the original failure when the cleanup itself fails', async () => {
    const { spawnImpl, invocations } = fakeSpawn((args) => {
      const script = args[5] ?? '';
      if (script === PREPARE_BACKUP_SCRIPT) return { code: 80, stderr: 'backup: the package could not be copied\n' };
      return { code: 79, stderr: 'clean: unexpected entry [x] in /tmp/x\n' };
    });

    const gateway = createWslGateway({ spawnImpl, log: silentLog } as never);
    const attempt = await gateway.prepareSharedBackup(request);

    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.detail).toBe('backup: the package could not be copied');
    expect(attempt.code).toBe(80);
    expect(invocations).toHaveLength(2);
  });
});
