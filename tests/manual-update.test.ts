/**
 * Manual update instructions.
 *
 * The app does not install anything any more: it shows exact commands for the
 * owner. These tests pin the version guard, the manager-specific install line,
 * the stop/install/start order and — most importantly — that an unknown or
 * unmanaged installation produces no command at all.
 */
import { describe, expect, it } from 'vitest';
import type { DshInstallation } from '../src/main/core/dsh-locate.js';
import {
  DSH_PACKAGE,
  buildManualUpdatePlan,
  isExactVersion,
  isSameVersion,
  isValidUnitName,
} from '../src/main/core/manual-update.js';

function installation(overrides: Partial<DshInstallation> = {}): DshInstallation {
  return {
    path: '/home/triag/.npm-global/bin/dsh',
    realPath: '/home/triag/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    symlink: true,
    version: '0.2.1',
    manager: 'npm',
    prefix: '/home/triag/.npm-global',
    packageDir: '/home/triag/.npm-global/lib/node_modules/@deepseek-ai/dsh',
    writable: true,
    npmPath: '/usr/bin/npm',
    source: 'login-shell',
    foreignProcesses: 0,
    foreignPids: [],
    loginShellRealPath: '/home/triag/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    loginShellVersion: '0.2.1',
    ...overrides,
  };
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

describe('unit name guard', () => {
  it('accepts a real service name and rejects shell text', () => {
    expect(isValidUnitName('dsh-web.service')).toBe(true);
    expect(isValidUnitName('dsh-web-dev@1.service')).toBe(true);
    for (const value of ['', 'dsh-web', '../../evil.service', 'dsh; rm -rf /.service', 'dsh web.service', null, 7]) {
      expect(isValidUnitName(value)).toBe(false);
    }
  });
});

describe('manual update commands', () => {
  it('stops the system unit, installs the exact npm version and starts it again', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: { scope: 'system', name: 'dsh-web.service' },
    });
    expect(plan.state).toBe('pending');
    expect(plan.installed).toBe('0.2.1');
    expect(plan.commands).toEqual([
      'sudo systemctl stop dsh-web.service',
      `"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`,
      'sudo systemctl start dsh-web.service',
    ]);
  });

  it('uses a user unit without sudo', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: { scope: 'user', name: 'dsh-web.service' },
    });
    expect(plan.commands).toEqual([
      'systemctl --user stop dsh-web.service',
      `"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`,
      'systemctl --user start dsh-web.service',
    ]);
  });

  it('uses pnpm when pnpm owns the installation', () => {
    const plan = buildManualUpdatePlan({
      installation: installation({ manager: 'pnpm', npmPath: null }),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(plan.commands).toEqual([`pnpm add -g ${DSH_PACKAGE}@0.2.2`]);
  });

  it('never invents a unit for a backend started by hand', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: null,
    });
    expect(plan.commands).toEqual([`"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`]);
    expect(plan.description).toContain('not started by systemd');
  });

  it('names the pid of its own backend instead of telling the owner to quit', () => {
    // Quit deliberately leaves that backend running, so "quit the app" would
    // leave the installation in use while npm replaces the files it executes.
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'owned',
      unit: null,
      ownedPid: 194,
    });
    expect(plan.commands).toEqual(['kill 194; sleep 2', `"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`]);
    expect(plan.description).toContain('194');
    expect(plan.description).not.toContain('Quit');
  });

  it('shows no command when the published version could not be checked', () => {
    // The cache keeps the last version after a failed lookup; presenting it as
    // current would produce a command for a version that may not be the newest.
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      targetError: 'upstream lookup timed out',
      backend: 'attached',
      unit: { scope: 'system', name: 'dsh-web.service' },
    });
    expect(plan.commands).toEqual([]);
    expect(plan.state).toBe('unknown');
    expect(plan.description).toContain('upstream lookup timed out');
  });

  it('says the install needs root when the prefix is not writable', () => {
    const plan = buildManualUpdatePlan({
      installation: installation({ writable: false }),
      target: '0.2.2',
      backend: 'attached',
      unit: { scope: 'system', name: 'dsh-web.service' },
    });
    expect(plan.description).toContain('needs root');
    // The command is not escalated: npm as root is the owner's decision, not ours.
    expect(plan.commands.some((line) => line.startsWith('sudo') && line.includes('install'))).toBe(false);
  });

  it('never stops a backend the app started itself without a known pid', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'owned',
      unit: null,
    });
    expect(plan.commands).toEqual([`"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`]);
    expect(plan.description).toContain('still using the installation');
  });

  it('shows only the install line when no backend is running', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(plan.commands).toEqual([`"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`]);
    expect(plan.description).toContain('start the backend again');
  });

  it('drops a unit name that does not pass the guard', () => {
    const plan = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: { scope: 'system', name: '..;rm -rf' },
    });
    expect(plan.commands).toEqual([`"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" ${DSH_PACKAGE}@0.2.2`]);
    expect(plan.description).toContain('could not be identified reliably');
  });

  it('reports the installed state and no command when the versions agree', () => {
    const plan = buildManualUpdatePlan({
      installation: installation({ version: '0.2.2' }),
      target: '0.2.2',
      backend: 'attached',
      unit: { scope: 'system', name: 'dsh-web.service' },
    });
    expect(plan.state).toBe('installed');
    expect(plan.commands).toEqual([]);
    expect(plan.description).toContain('0.2.2');
  });

  it('shows no command when the target version is invalid or unknown', () => {
    for (const target of [null, 'latest', '0.2.2; rm -rf /']) {
      const plan = buildManualUpdatePlan({
        installation: installation(),
        target,
        backend: 'none',
        unit: null,
      });
      expect(plan.state).toBe('unknown');
      expect(plan.commands).toEqual([]);
      expect(plan.description).not.toBeNull();
    }
  });

  it('shows no command when the installation is missing or unmanaged', () => {
    const missing = buildManualUpdatePlan({ installation: null, target: '0.2.2', backend: 'none', unit: null });
    expect(missing.commands).toEqual([]);
    expect(missing.state).toBe('unknown');

    const unknownManager = buildManualUpdatePlan({
      installation: installation({ manager: 'unknown' }),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(unknownManager.commands).toEqual([]);
    expect(unknownManager.state).toBe('unknown');
  });

  it('shows no command when the installed version cannot be read', () => {
    const plan = buildManualUpdatePlan({
      installation: installation({ version: null }),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(plan.state).toBe('unknown');
    expect(plan.commands).toEqual([]);
  });
});
