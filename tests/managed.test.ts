/**
 * The unit that owns the attached backend.
 *
 * An update replaces the installation the serving process executes, so the app
 * asks that process's manager to stop and start it. These tests pin the two
 * halves that must never regress: what the scripts are allowed to touch, and how
 * their reports are read.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ArgumentError } from '../src/main/wsl/args.js';
import {
  CONTROL_MANAGED_SCRIPT,
  PROBE_MANAGED_SCRIPT,
  buildControlManagedArgs,
  buildProbeManagedArgs,
  parseManagedReport,
  sudoersLines,
} from '../src/main/wsl/managed.js';

const marker = (fields: string): string => `__dsh_wsl_managed__ ${fields}`;

describe('managed backend probe', () => {
  it('reports the unit behind a system-scope pid', () => {
    expect(parseManagedReport(marker('scope=system unit=dsh-web.service can=1 user=triag'))).toEqual({
      scope: 'system',
      unit: 'dsh-web.service',
      canControl: true,
      user: 'triag',
    });
  });

  it('reports a user-scope unit and a hand-started process', () => {
    expect(parseManagedReport(marker('scope=user unit=dsh-web.service can=1 user=triag'))).toEqual({
      scope: 'user',
      unit: 'dsh-web.service',
      canControl: true,
      user: 'triag',
    });
    expect(parseManagedReport(marker('scope=none unit=- can=0 user=triag'))).toEqual({
      scope: 'none',
      unit: null,
      canControl: false,
      user: 'triag',
    });
  });

  it('treats noise, a missing reply and a hostile unit name as "no manager"', () => {
    for (const text of [
      '',
      'systemctl: command not found',
      marker('scope=system unit=../../evil can=1 user=triag'),
      marker('scope=root unit=dsh-web.service can=1 user=triag'),
      marker('scope=system can=1 user=triag'),
    ]) {
      expect(parseManagedReport(text)).toEqual({ scope: 'none', unit: null, canControl: false, user: 'user' });
    }
  });

  it('validates its inputs before they reach wsl.exe', () => {
    expect(buildProbeManagedArgs({ distro: 'Ubuntu', pid: 194 })).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      '/bin/sh',
      '-c',
      PROBE_MANAGED_SCRIPT,
      '194',
    ]);
    expect(() => buildProbeManagedArgs({ distro: 'Ubuntu', pid: 0 })).toThrow(ArgumentError);
    expect(() => buildProbeManagedArgs({ distro: 'Ubuntu && rm -rf /', pid: 1 })).toThrow(ArgumentError);
    expect(() => buildProbeManagedArgs({ distro: 'Ubuntu', pid: 1.5 })).toThrow(ArgumentError);
  });

  it('only ever names a single unit and a stop/start action', () => {
    const argv = buildControlManagedArgs({
      distro: 'Ubuntu',
      scope: 'system',
      unit: 'dsh-web.service',
      action: 'stop',
    });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', CONTROL_MANAGED_SCRIPT]);
    expect(argv.slice(6)).toEqual(['system', 'dsh-web.service', 'stop']);
    expect(() =>
      buildControlManagedArgs({ distro: 'Ubuntu', scope: 'system', unit: 'a; rm -rf /', action: 'stop' }),
    ).toThrow(ArgumentError);
    expect(() =>
      buildControlManagedArgs({
        distro: 'Ubuntu',
        scope: 'user',
        unit: 'dsh-web.service',
        action: 'restart' as unknown as 'stop',
      }),
    ).toThrow(ArgumentError);
    // No script path, no shell text, no free-form argument can slip in.
    for (const line of CONTROL_MANAGED_SCRIPT.split('\n')) {
      expect(line).not.toMatch(/eval|\$\(\(/);
    }
  });

  it('offers the narrowest rule that makes an update possible', () => {
    expect(sudoersLines({ user: 'triag', unit: 'dsh-web.service' })).toEqual([
      'triag ALL=(root) NOPASSWD: /usr/bin/systemctl stop dsh-web.service, /usr/bin/systemctl start dsh-web.service',
    ]);
    // The rule never grants a shell, a wildcard or another unit.
    const rule = sudoersLines({ user: 'triag', unit: 'dsh-web.service' })[0] ?? '';
    expect(rule).not.toContain('ALL=(root) NOPASSWD: ALL');
    expect(rule).not.toContain('*');
    expect(rule).not.toContain('/bin/sh');
  });
});

describe('managed backend probe on this host (linux)', () => {
  const itLinux = it.skipIf(process.platform !== 'linux');

  itLinux('never invents a unit for a process outside one', () => {
    // A child of the test runner lives in the same cgroup as the runner. On a
    // normal Linux CI host that cgroup is a `.scope`, not a `.service`, so the
    // script must answer "no manager" instead of deriving a bogus unit name.
    const run = spawnSync('/bin/sh', ['-c', PROBE_MANAGED_SCRIPT, String(process.pid)], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    const report = parseManagedReport(run.stdout);
    if (report.scope === 'none') {
      expect(report.unit).toBeNull();
      expect(report.canControl).toBe(false);
    } else {
      // Inside a container the sandbox itself may run as a unit: then the report
      // has to name it, and only claim control when the host really allows it.
      expect(report.unit).toMatch(/\.service$/);
      expect(report.canControl).toBe(false);
    }
  });

  itLinux('rejects a pid that does not exist', () => {
    const run = spawnSync('/bin/sh', ['-c', PROBE_MANAGED_SCRIPT, 'not-a-pid'], { encoding: 'utf8' });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('rejected pid');
  });
});
