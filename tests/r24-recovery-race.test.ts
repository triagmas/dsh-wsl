import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import type { ServerHandle, StartServerRequest, WslGateway, WebClient } from '../src/main/core/supervisor.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import {
  BACKEND_PID,
  FakeServer,
  FakeWeb,
  FakeWsl,
  backendProbe,
  lastStatus,
  type PortState,
} from './helpers.js';
import { DEFAULT_CONFIG, type AppConfig, type ShellStatus } from '../src/shared/types.js';
import type { Logger } from '../src/main/core/logger.js';

/**
 * Issue #24, second defect: recovery raced in-flight starts.
 *
 * The exit handler used to run `handleLoss` in parallel with the start that
 * owned the same process, so a deterministic startup failure (exit 127) produced
 * duplicate `bringUp` calls, wasted retries and an `InvalidTransitionError`.
 */
class CrashWsl extends FakeWsl {
  private readonly alive = new Set<number>();
  private nextPid = BACKEND_PID;
  /** When set, every newly started backend dies immediately with this exit. */
  crashCode: number | null = null;
  crashStderr = "env: 'node': No such file or directory";
  /** Extra exits that are delivered for a process that already finished. */
  readonly deliveredExits = new Map<number, FakeServer>();

  constructor(options: ConstructorParameters<typeof FakeWsl>[0] = {}) {
    super(options);
  }

  override startServer(request: StartServerRequest): ServerHandle {
    this.starts.push(request);
    const pid = (this.nextPid += 1);
    const crashing = this.crashCode !== null;
    if (!crashing) this.alive.add(pid);
    const server = new FakeServer({
      pid,
      announceUrl: !crashing,
      urlPort: request.port,
      stderr: crashing ? this.crashStderr : 'stderr tail',
    });
    this.servers.push(server);
    this.deliveredExits.set(pid, server);
    queueMicrotask(() => {
      if (crashing) {
        this.alive.delete(pid);
        server.exit({ code: this.crashCode, signal: null });
      } else {
        server.announce();
      }
    });
    return server;
  }

  override async probeProcess(_distro: string, pid: number) {
    return this.alive.has(pid) ? backendProbe({ cmdline: `/usr/bin/node /usr/local/bin/dsh web --host 127.0.0.1 --port ${this.lastPort()} --no-open` }) : null;
  }

  private lastPort(): number {
    return this.starts.at(-1)?.port ?? BACKEND_PID;
  }

  /** Mark a process as gone (used by the signal hook). */
  releasePid(pid: number): void {
    this.alive.delete(pid);
  }

  /** Deliver an exit for a backend that is not the current one any more. */
  deliverStaleExit(index: number): void {
    this.servers[index]?.exit({ code: 127, signal: null });
  }
}

function capturingLogger(): { log: Logger; lines: (level?: string) => string[] } {
  const entries: string[] = [];
  const record = (level: string) => (message: string) => entries.push(`${level} ${message}`);
  return {
    log: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
      path: () => '/tmp/r24.log',
      tail: () => '',
    },
    lines: (level?: string) =>
      level === undefined ? [...entries] : entries.filter((entry) => entry.startsWith(`${level} `)),
  };
}

interface TestHarness {
  config: AppConfig;
  wsl: CrashWsl;
  web: FakeWeb;
  registry: ReturnType<typeof createMemoryRegistry>;
  statuses: ShellStatus[];
  deps: ConstructorParameters<typeof Supervisor>[0];
  logger: ReturnType<typeof capturingLogger>;
}

function createCrashHarness(options: { config?: Partial<AppConfig>; portState?: PortState } = {}): TestHarness {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...options.config };
  const statuses: ShellStatus[] = [];
  const wsl = new CrashWsl();
  const web = new FakeWeb();
  const registry = createMemoryRegistry();
  const logger = capturingLogger();
  // A signalled process really goes away; the supervisor then escalates no further.
  wsl.signalHook = (pid) => wsl.releasePid(pid);
  return {
    config,
    wsl,
    web,
    registry,
    statuses,
    logger,
    deps: {
      config: () => config,
      wsl: wsl as unknown as WslGateway,
      web: web as unknown as WebClient,
      registry,
      log: logger.log,
      probePort: async () => options.portState ?? 'free',
      sleep: async () => undefined,
      now: () => Date.now(),
      publish: (status: ShellStatus) => statuses.push(status),
      appVersion: '0.0.0-test',
      logPath: () => '/tmp/r24.log',
      startupTimeoutMs: 2_000,
      healthAttempts: 2,
      stopGraceMs: 0,
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('issue #24: startup failures are reported once, without a recovery storm', () => {
  it('reports exit 127 with the backend stderr instead of a vague ownership error', async () => {
    const harness = createCrashHarness();
    harness.wsl.crashCode = 127;
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    await flush();

    expect(supervisor.state).toBe('ERROR');
    // The start that owns the process reports the failure; no parallel recovery.
    expect(harness.wsl.starts).toHaveLength(1);
    const detail = lastStatus(harness.statuses).detail ?? '';
    expect(detail).toContain('127');
    expect(detail).toContain("env: 'node'");
    // Nothing is left behind: the handle is stopped and the record is cleared.
    expect(harness.wsl.servers[0]?.stopCalls).toBe(1);
    expect(harness.registry.read()).toBeNull();
    expect(harness.logger.lines()).not.toContainEqual(expect.stringContaining('InvalidTransitionError'));
  });

  it('does not start a second recovery when a manual restart fails deterministically', async () => {
    const harness = createCrashHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    harness.wsl.crashCode = 127;
    await expect(supervisor.restart()).rejects.toBeTruthy();
    await flush();

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(2);
    expect(lastStatus(harness.statuses).detail).toContain('127');
    expect(harness.logger.lines()).not.toContainEqual(expect.stringContaining('InvalidTransitionError'));
  });

  it('ignores an exit from a backend that was replaced (generation guard)', async () => {
    const harness = createCrashHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    await supervisor.restart();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(2);

    // The restart legitimately stopped the previous backend; only signals that
    // arrive afterwards could belong to the replacement.
    const signalsAfterRestart = harness.wsl.signals.length;

    // The first backend reports its exit after the second one took over.
    harness.wsl.deliverStaleExit(0);
    await flush();

    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
    // The replacement backend is never touched because of a stale event.
    expect(harness.wsl.signals).toHaveLength(signalsAfterRestart);
  });

  it('deduplicates recovery requests for the same backend', async () => {
    const harness = createCrashHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    const first = harness.wsl.servers[0];
    first?.exit({ code: 1, signal: null });
    // A health failure for the same generation arrives at the same time.
    await Promise.all([supervisor.handleServerExit({ code: 1, signal: null }, 1), supervisor.healthTick()]);
    await flush();

    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
  });

  it('reports the exit code when the backend dies after announcing nothing', async () => {
    const harness = createCrashHarness({ config: { maxRestartAttempts: 2 } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    harness.wsl.crashCode = 3;
    harness.wsl.crashStderr = 'fatal: cannot bind';
    harness.wsl.servers[0]?.exit({ code: 3, signal: null });
    await flush();

    // Every attempt failed with the process diagnostic (1 start + 2 retries).
    expect(harness.wsl.starts).toHaveLength(3);
    expect(supervisor.state).toBe('ERROR');
    expect(harness.logger.lines('error').join('\n')).toContain('code 3');
  });
});

describe('issue #24: isolation toggle across restarts and failures', () => {
  it('switches launch arguments and isolation setup in both directions', async () => {
    const harness = createCrashHarness({ config: { isolateEnvironment: true } });
    const supervisor = new Supervisor(harness.deps);

    await supervisor.start();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts[0]).toMatchObject({
      isolationRoot: '~/.local/share/wsl-web-shell',
      workspace: '~/.local/share/wsl-web-shell/workspace',
    });
    expect(harness.wsl.isolationPreparations).toHaveLength(1);

    // Isolation off: no preparation, plain home, no isolated workspace.
    harness.config.isolateEnvironment = false;
    await supervisor.restart();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts[1]).toMatchObject({ isolationRoot: '-', workspace: '~' });
    expect(harness.wsl.isolationPreparations).toHaveLength(1);
    expect(harness.wsl.runtimeQueries.at(-1)).toMatchObject({ isolationRoot: null });

    // Back on again: the isolated root is prepared and used.
    harness.config.isolateEnvironment = true;
    await supervisor.restart();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts[2]).toMatchObject({
      isolationRoot: '~/.local/share/wsl-web-shell',
      workspace: '~/.local/share/wsl-web-shell/workspace',
    });
    expect(harness.wsl.isolationPreparations).toHaveLength(2);
  });

  it('fails cleanly in both modes and recovers after switching back', async () => {
    const harness = createCrashHarness({ config: { isolateEnvironment: false } });
    const supervisor = new Supervisor(harness.deps);

    harness.wsl.crashCode = 127;
    await expect(supervisor.start()).rejects.toBeTruthy();
    await flush();
    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.registry.read()).toBeNull();
    // A dead process is never signalled and no port is left held.
    expect(harness.wsl.signals).toHaveLength(0);

    // Isolation on, still failing: the same clean failure.
    harness.config.isolateEnvironment = true;
    await expect(supervisor.retry()).rejects.toBeTruthy();
    await flush();
    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(2);
    expect(harness.wsl.isolationPreparations).toHaveLength(1);
    expect(harness.wsl.signals).toHaveLength(0);

    // Back to isolation off and a working runtime: the app recovers.
    harness.config.isolateEnvironment = false;
    harness.wsl.crashCode = null;
    await supervisor.retry();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(3);
    expect(harness.wsl.starts[2]).toMatchObject({ isolationRoot: '-', workspace: '~' });
  });
});
