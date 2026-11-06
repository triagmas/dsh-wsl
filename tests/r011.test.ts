/**
 * R01.1 regression suite: tray visibility wiring, reconnection after restart,
 * ownership-preserving loss handling, PID revalidation before SIGKILL and
 * display-level secret redaction.
 */
import { describe, expect, it } from 'vitest';
import { Supervisor } from '../src/main/core/supervisor.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { sanitizeForDisplay, sanitizeOptional, MAX_DISPLAY_LENGTH } from '../src/main/core/display.js';
import { decideReadyVisibility, decideTrayOpen, shouldActivateSplash } from '../src/main/core/visibility.js';
import { backendProbe, createHarness, lastStatus, BACKEND_PID, BACKEND_START_TIME, PORT } from './helpers.js';
import type { OwnedServerRecord } from '../src/main/core/ownership.js';

const record: OwnedServerRecord = {
  presetId: 'deepseek-harness',
  distro: 'Ubuntu',
  port: PORT,
  pid: BACKEND_PID,
  startTime: BACKEND_START_TIME,
  workspace: '~',
  startedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '0.0.0-test',
};

const settle = (ms = 30): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, ms));

describe('visibility policy', () => {
  it('shows the window on the first ready state when configured', () => {
    expect(decideReadyVisibility({ openOnLaunch: true, everShown: false, visible: false })).toBe('show');
  });

  it('never re-shows a window the user hid', () => {
    expect(decideReadyVisibility({ openOnLaunch: true, everShown: true, visible: false })).toBe('keep-hidden');
  });

  it('never hides or re-focuses an already visible window', () => {
    expect(decideReadyVisibility({ openOnLaunch: false, everShown: true, visible: true })).toBe('keep-hidden');
  });

  it('activates the splash only when the app window is on screen', () => {
    expect(shouldActivateSplash(true)).toBe(true);
    expect(shouldActivateSplash(false)).toBe(false);
  });

  it('routes tray Open to the overlay when there is nothing loadable', () => {
    expect(decideTrayOpen('ERROR')).toBe('overlay');
    expect(decideTrayOpen('RECOVERING')).toBe('overlay');
    expect(decideTrayOpen('QUITTING')).toBe('overlay');
    expect(decideTrayOpen('READY')).toBe('window');
    expect(decideTrayOpen('HIDDEN_IN_TRAY')).toBe('window');
    expect(decideTrayOpen('STARTING_WEB')).toBe('window');
  });
});

describe('display sanitization', () => {
  it('removes terminal escapes and control characters', () => {
    expect(sanitizeForDisplay('\u001B[31mboom\u001B[0m \u0007done')).toBe('boom done');
  });

  it('collapses whitespace and keeps readable line breaks', () => {
    expect(sanitizeForDisplay('  line   one \r\n\n  line two  ')).toBe('line one\nline two');
  });

  it('redacts launch tokens in arbitrary diagnostics', () => {
    const raw = 'open http://127.0.0.1:3080/?token=test-token-0123456789abcdef now';
    expect(sanitizeForDisplay(raw)).toBe('open http://127.0.0.1:3080/?token=[redacted] now');
  });

  it('caps very long diagnostics', () => {
    const long = 'x'.repeat(MAX_DISPLAY_LENGTH * 2);
    const safe = sanitizeForDisplay(long);
    expect(safe.length).toBeLessThanOrEqual(MAX_DISPLAY_LENGTH);
    expect(safe.endsWith('…')).toBe(true);
  });

  it('keeps "no detail" distinguishable from empty text', () => {
    expect(sanitizeOptional(null)).toBeNull();
    expect(sanitizeOptional('   ')).toBeNull();
    expect(sanitizeOptional(' hi ')).toBe('hi');
  });
});

describe('tray state wiring', () => {
  it('publishes HIDDEN_IN_TRAY when the window is hidden and READY again when shown', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.state).toBe('READY');

    supervisor.markHidden(true);
    expect(supervisor.state).toBe('HIDDEN_IN_TRAY');
    expect(supervisor.getStatus().state).toBe('HIDDEN_IN_TRAY');

    supervisor.markHidden(false);
    expect(supervisor.state).toBe('READY');
    expect(lastStatus(harness.statuses).state).toBe('READY');
  });

  it('ignores visibility changes that have no tray meaning', async () => {
    const harness = createHarness({ wsl: { distros: ['Debian'] } });
    const supervisor = new Supervisor(harness.deps);
    await expect(supervisor.start()).rejects.toBeTruthy();
    expect(supervisor.state).toBe('ERROR');

    supervisor.markHidden(true);
    expect(supervisor.state).toBe('ERROR');
    expect(supervisor.isWindowHidden).toBe(true);
  });

  it('stays hidden after recovering while the window was in the tray', async () => {
    let unhealthyLeft = 0;
    const harness = createHarness({ web: { health: () => (unhealthyLeft-- > 0 ? 0 : 200) } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    supervisor.markHidden(true);
    expect(supervisor.state).toBe('HIDDEN_IN_TRAY');
    const afterHide = harness.statuses.length;

    unhealthyLeft = 2;
    await supervisor.healthTick();
    await supervisor.healthTick();
    await settle();

    expect(harness.wsl.starts).toHaveLength(2);
    // Recovery restores the tray state instead of popping the window back up.
    expect(supervisor.state).toBe('HIDDEN_IN_TRAY');
    expect(harness.statuses.slice(afterHide).map((status) => status.state)).not.toContain('READY');
  });

  it('becomes READY when the user opens the window during recovery', async () => {
    let unhealthyLeft = 0;
    const harness = createHarness({ web: { health: () => (unhealthyLeft-- > 0 ? 0 : 200) } });
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    supervisor.markHidden(true);

    unhealthyLeft = 2;
    await supervisor.healthTick();
    supervisor.markHidden(false);
    await supervisor.healthTick();
    await settle();

    expect(supervisor.state).toBe('READY');
  });
});

describe('reconnect after restart', () => {
  it('increments the ready generation on every successful reconnect', async () => {
    const harness = createHarness();
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(supervisor.readyGeneration).toBe(1);

    harness.wsl.servers[0]?.exit();
    await settle();

    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.readyGeneration).toBe(2);
  });

  it('increments the generation after an explicit restart', async () => {
    const registry = createMemoryRegistry(record);
    let portBusy = true;
    let alive = true;
    const harness = createHarness({
      portState: () => (portBusy ? 'occupied' : 'free'),
      registry,
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal !== 'TERM') return;
      alive = false;
      portBusy = false;
    };
    harness.wsl.startHook = () => {
      alive = true;
      portBusy = true;
    };
    const supervisor = new Supervisor(harness.deps);

    // App start reuses the live app-owned backend recorded in the profile.
    await supervisor.start();
    expect(supervisor.readyGeneration).toBe(1);
    expect(harness.wsl.starts).toHaveLength(0);

    await supervisor.restart();
    expect(harness.wsl.starts).toHaveLength(1);
    expect(supervisor.readyGeneration).toBe(2);
  });
});

describe('loss handling keeps safe ownership', () => {
  it('reclaims a hung-but-alive owned backend before starting a fresh one', async () => {
    let alive = false;
    let portBusy = false;
    const harness = createHarness({
      portState: () => (portBusy ? 'occupied' : 'free'),
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.deps.stopGraceMs = 40;
    harness.wsl.startHook = () => {
      alive = true;
      portBusy = true;
    };
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal !== 'TERM') return;
      alive = false;
      portBusy = false;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();
    expect(harness.wsl.starts).toHaveLength(1);

    // Health collapses while the process is still alive (hung server).
    let unhealthyLeft = 2;
    harness.web.health = async () => (unhealthyLeft-- > 0 ? 0 : 200);
    await supervisor.healthTick();
    await supervisor.healthTick();
    await settle(80);

    expect(harness.wsl.signals).toEqual([{ pid: BACKEND_PID, signal: 'TERM' }]);
    expect(harness.wsl.starts).toHaveLength(2);
    expect(supervisor.state).toBe('READY');
  });

  it('fails closed when the port is taken by a listener it cannot prove', async () => {
    let alive = false;
    let portBusy = false;
    const harness = createHarness({
      portState: () => (portBusy ? 'occupied' : 'free'),
      wsl: { probe: (pid) => (alive && pid === BACKEND_PID ? backendProbe() : null) },
    });
    harness.wsl.startHook = () => {
      alive = true;
      portBusy = true;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    // The backend dies; an unrelated service grabs the port in the meantime.
    alive = false;
    portBusy = true;
    let unhealthyLeft = 2;
    harness.web.health = async () => (unhealthyLeft-- > 0 ? 0 : 200);
    await supervisor.healthTick();
    await supervisor.healthTick();
    await settle(60);

    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(1);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(lastStatus(harness.statuses).detail).toContain('does not own');
  });

  it('does not adopt a foreign listener even when a stale record exists', async () => {
    const registry = createMemoryRegistry(record);
    const harness = createHarness({
      portState: 'occupied',
      registry,
      wsl: { probe: () => backendProbe({ port: 9999 }) },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    expect(supervisor.state).toBe('ERROR');
    expect(harness.wsl.starts).toHaveLength(0);
    expect(harness.wsl.signals).toHaveLength(0);
    expect(registry.read()).toBeNull();
  });
});

describe('PID revalidation before escalated termination', () => {
  const reusedProbe = (patch: Partial<ReturnType<typeof backendProbe>>) => backendProbe(patch);

  it('withholds SIGKILL when the PID was reused with a different start time', async () => {
    let reused = false;
    const registry = createMemoryRegistry();
    const harness = createHarness({
      registry,
      // Identical command line, different start time: the PID was recycled.
      wsl: { probe: () => (reused ? reusedProbe({ startTime: '555555' }) : backendProbe()) },
    });
    harness.deps.stopGraceMs = 0;
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal === 'TERM') reused = true;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    await supervisor.shutdown();

    expect(harness.wsl.signals).toEqual([{ pid: BACKEND_PID, signal: 'TERM' }]);
    expect(harness.wsl.signals.some((entry) => entry.signal === 'KILL')).toBe(false);
  });

  it('withholds SIGKILL when the command line no longer matches our backend', async () => {
    let foreign = false;
    const harness = createHarness({
      wsl: {
        probe: () => {
          if (!foreign) return backendProbe();
          const cmdline = '/usr/bin/node /opt/other-service/server.js --port 3080';
          return { startTime: BACKEND_START_TIME, cmdline, argv: cmdline.split(' ') };
        },
      },
    });
    harness.deps.stopGraceMs = 0;
    harness.wsl.signalHook = (_pid, signal) => {
      if (signal === 'TERM') foreign = true;
    };
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    await supervisor.shutdown();

    expect(harness.wsl.signals).toEqual([{ pid: BACKEND_PID, signal: 'TERM' }]);
  });

  it('still escalates to SIGKILL for a verified backend that ignores SIGTERM', async () => {
    const harness = createHarness({ wsl: { probe: () => backendProbe() } });
    harness.deps.stopGraceMs = 0;
    const supervisor = new Supervisor(harness.deps);
    await supervisor.start();

    await supervisor.shutdown();

    expect(harness.wsl.signals.map((entry) => entry.signal)).toEqual(['TERM', 'KILL']);
  });
});

describe('secret redaction in status text', () => {
  it('never publishes a launch token captured from backend stderr', async () => {
    const tokenUrl = 'http://127.0.0.1:3080/?token=test-token-0123456789abcdef';
    const harness = createHarness({
      wsl: {
        exitBeforeReady: {
          code: 1,
          stderr: `\u001B[31mfatal\u001B[0m could not start ${tokenUrl}\nstack: Error: boom`,
        },
      },
    });
    const supervisor = new Supervisor(harness.deps);

    await expect(supervisor.start()).rejects.toBeTruthy();
    await settle();

    expect(supervisor.state).toBe('ERROR');
    const published = JSON.stringify(harness.statuses);
    expect(published).not.toContain('test-token-0123456789abcdef');
    const details = harness.statuses.map((status) => status.detail ?? '').join('\n');
    expect(details).toContain('[redacted]');
    // The captured stderr still reaches the user, only with the secret removed.
    expect(details).toContain('fatal could not start');
    expect(details).not.toContain('\u001B');
  });

  it('keeps every published message and detail free of control characters', async () => {
    const harness = createHarness({
      wsl: {
        exitBeforeReady: { code: 1, stderr: '\u0007\u001B[35mchaos\u001B[0m \u0000stderr' },
      },
    });
    const supervisor = new Supervisor(harness.deps);
    await expect(supervisor.start()).rejects.toBeTruthy();
    await settle();

    for (const status of harness.statuses) {
      expect(status.message).not.toMatch(/[\u0000-\u001F\u007F]/);
      if (status.detail !== null) expect(status.detail).not.toMatch(/[\u0000-\u001F\u007F]/);
    }
  });
});
