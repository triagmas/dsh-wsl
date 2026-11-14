/**
 * The keepalive must never open a console window.
 *
 * `detached: true` on Windows sets DETACHED_PROCESS, which defeats
 * CREATE_NO_WINDOW: the console program allocates its own console and the default
 * terminal application opens a visible window. Closing that window kills the one
 * client holding the distribution open, and WSL2 powers the distro off with the
 * backend inside it. Observed on the owner's machine on 2026-11-14.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createWslGateway } from '../src/main/wsl/gateway.js';
import type { Logger } from '../src/main/core/logger.js';

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  unrefCalls = 0;
  constructor(pid = 4242) {
    super();
    this.pid = pid;
  }
  unref(): void {
    this.unrefCalls += 1;
  }
  kill(): boolean {
    return true;
  }
}

function logger(): Logger {
  const noop = (): void => undefined;
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

describe('distribution keepalive', () => {
  it('never spawns a detached console program', async () => {
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const child = new FakeChild();
    const gateway = createWslGateway({
      log: logger(),
      wslExe: 'wsl.exe',
      timeouts: { keepaliveAliveMs: 10 },
      spawnImpl: ((exe: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ args, options });
        return child;
      }) as never,
    });

    const pid = await gateway.ensureKeepalive('Ubuntu', null);

    expect(pid).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.detached).toBeUndefined();
    expect(calls[0]?.options.windowsHide).toBe(true);
    expect(child.unrefCalls).toBe(1);
  });

  it('does not report a keepalive that exited immediately', async () => {
    const child = new FakeChild();
    const spawned = new Promise<void>((resolve) => {
      // Exit on the next tick, after the gateway has attached its listeners.
      setTimeout(() => {
        child.exitCode = 1;
        child.emit('exit', 1, null);
        resolve();
      }, 1);
    });
    const gateway = createWslGateway({
      log: logger(),
      wslExe: 'wsl.exe',
      timeouts: { keepaliveAliveMs: 30 },
      spawnImpl: (() => child) as never,
    });

    const pid = await gateway.ensureKeepalive('Ubuntu', null);
    await spawned;

    expect(pid).toBeNull();
  });
});
