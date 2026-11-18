/**
 * Issue #29: recovery has to reach a terminal state.
 *
 * The incident: a backend exited, `runRecovery` called `releaseOwnedProcess()`
 * outside any `try/catch`, the ownership probe timed out after 10 s and the
 * rejection escaped into the outer `exit handler failed` log. The lifecycle
 * stayed in RECOVERING, `healthTick` returns early in that state, and nothing
 * retried - the splash stayed for ~43 minutes.
 *
 * These tests drive the same path with a fake gateway whose `probeProcess`
 * rejects like `wsl.exe` does on timeout. They assert the observable outcome
 * (state, retry, ownership record, one start, one log line) rather than private
 * fields.
 */
import { describe, expect, it } from 'vitest';
import { ShellError, Supervisor } from '../src/main/core/supervisor.js';
import type { WslGateway, WebClient } from '../src/main/core/supervisor.js';
import type { ProcessProbe } from '../src/main/wsl/output.js';
import { createMemoryExternalStore } from '../src/main/core/external.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { BACKEND_PID, FakeWeb, FakeWsl, backendProbe, lastStatus } from './helpers.js';
import { DEFAULT_CONFIG, type AppConfig, type ShellStatus } from '../src/shared/types.js';
import type { Logger } from '../src/main/core/logger.js';

/** What the fake probe answers: a live backend, silence, or the WSL timeout. */
type ProbeMode = 'alive' | 'gone' | 'timeout';

function capturingLogger(): { log: Logger; lines: (level?: string) => string[] } {
  const entries: string[] = [];
  const record = (level: string) => (message: string) => entries.push(`${level} ${message}`);
  return {
    log: {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
      path: () => '/tmp/r29.log',
      tail: () => '',
    },
    lines: (level?: string) =>
      level === undefined ? [...entries] : entries.filter((entry) => entry.startsWith(`${level} `)),
  };
}

interface Harness {
  config: AppConfig;
  wsl: FakeWsl;
  web: FakeWeb;
  registry: ReturnType<typeof createMemoryRegistry>;
  statuses: ShellStatus[];
  logger: ReturnType<typeof capturingLogger>;
  mode: { value: ProbeMode };
  health: { value: number };
  deps: ConstructorParameters<typeof Supervisor>[0];
}

function createHarness(config: Partial<AppConfig> = {}): Harness {
  const resolved: AppConfig = { ...DEFAULT_CONFIG, ...config };
  const statuses: ShellStatus[] = [];
  const logger = capturingLogger();
  const mode: { value: ProbeMode } = { value: 'alive' };
  const health: { value: number } = { value: 200 };
  const wsl = new FakeWsl({
    // A probe that rejects is exactly what the gateway does on a WSL timeout:
    // `ShellError('unexpected', 'A WSL command timed out.')`.
    probe: (pid: number): ProcessProbe | null => {
      if (mode.value === 'timeout') {
        throw new ShellError('unexpected', 'A WSL command timed out.', 'The distribution may be unresponsive.');
      }
      if (mode.value === 'gone') return null;
      return pid === BACKEND_PID ? backendProbe({ port: wsl.lastStartPort() }) : null;
    },
  });
  const web = new FakeWeb({ health: () => health.value });
  const registry = createMemoryRegistry();
  return {
    config: resolved,
    wsl,
    web,
    registry,
    statuses,
    logger,
    mode,
    health,
    deps: {
      config: () => resolved,
      wsl: wsl as unknown as WslGateway,
      web: web as unknown as WebClient,
      registry,
      external: createMemoryExternalStore(),
      log: logger.log,
      probePort: async () => 'free',
      sleep: async () => undefined,
      now: () => Date.now(),
      publish: (status: ShellStatus) => statuses.push(status),
      appVersion: '0.0.0-test',
      logPath: () => '/tmp/r29.log',
      startupTimeoutMs: 2_000,
      healthAttempts: 2,
      stopGraceMs: 0,
      attachWaitMs: 20,
      attachPollMs: 5,
    },
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

const errorLines = (harness: Harness): string[] => harness.logger.lines('error');

describe('issue #29: recovery reaches a terminal state when the probe is unavailable', () => {
  it('ends in ERROR with Retry after a backend exit, keeps the record and starts nothing', async () => {
    const harness = createHarness({ maxRestartAttempts: 2 });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(1);
    const record = harness.registry.read();
    expect(record).not.toBeNull();

    harness.mode.value = 'timeout';
    harness.wsl.servers[0]?.exit({ code: 1, signal: null });
    await flush();

    // Terminal, retryable, and honest about what happened.
    expect(supervisor.state).toBe('ERROR');
    const status = lastStatus(harness.statuses);
    expect(status.state).toBe('ERROR');
    expect(status.canRetry).toBe(true);
    expect(status.detail ?? '').toContain('could not be checked');

    // Ownership was uncertain: no second backend, no signal, record untouched.
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(harness.registry.read()).toEqual(record);

    // One concise line, plus the terminal line `fail()` writes; no stack trace
    // and no token in either.
    const lines = errorLines(harness);
    expect(lines.some((line) => line.includes('recovery stopped: the stopped backend could not be checked'))).toBe(true);
    expect(lines.some((line) => line.includes('A WSL command timed out.'))).toBe(true);
    expect(harness.logger.lines().some((line) => line.includes('token='))).toBe(false);
  });

  it('reaches the same terminal state through two failing health ticks and never throws at the caller', async () => {
    const harness = createHarness({ maxRestartAttempts: 2 });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    harness.mode.value = 'timeout';
    harness.health.value = 503;

    await expect(supervisor.healthTick()).resolves.toBeUndefined();
    expect(supervisor.state).toBe('READY');
    await expect(supervisor.healthTick()).resolves.toBeUndefined();
    await flush();

    expect(supervisor.state).toBe('ERROR');
    expect(lastStatus(harness.statuses).canRetry).toBe(true);
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.registry.read()).not.toBeNull();
    expect(errorLines(harness).some((line) => line.includes('could not be checked'))).toBe(true);

    // Further ticks in ERROR are a no-op, not a second recovery.
    await supervisor.healthTick();
    await flush();
    expect(harness.wsl.starts).toHaveLength(1);
  });

  it('lets Retry bring the backend back and recover normally from the next loss', async () => {
    const harness = createHarness({ maxRestartAttempts: 2 });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    harness.mode.value = 'timeout';
    harness.wsl.servers[0]?.exit({ code: 1, signal: null });
    await flush();
    expect(supervisor.state).toBe('ERROR');

    // WSL answers again: the ownership proof is back, so the old backend may be
    // stopped by the normal, verified path and a new one started.
    harness.mode.value = 'alive';
    await supervisor.retry();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(2);

    // No leaked recoveryRunning / startInFlight: the next loss recovers again.
    harness.wsl.servers[1]?.exit({ code: 1, signal: null });
    await flush();
    expect(supervisor.state).toBe('READY');
    expect(harness.wsl.starts).toHaveLength(3);
    expect(supervisor.readyGeneration).toBeGreaterThan(0);
  });
});
