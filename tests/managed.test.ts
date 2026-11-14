/**
 * Read-only discovery of the unit that runs an attached backend.
 *
 * The manual update window names that unit, but the app must never control it.
 * These tests pin the report format, the parser and the fact that the probe asks
 * the kernel instead of sudo or systemctl.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ArgumentError } from '../src/main/wsl/args.js';
import { PROBE_MANAGED_SCRIPT, buildProbeManagedArgs, classifyCgroup, parseManagedReport } from '../src/main/wsl/managed.js';

const marker = (fields: string): string => `__dsh_wsl_managed__ ${fields}`;

describe('managed backend probe', () => {
  it('reads the unit out of a real cgroup v2 record', () => {
    // What the kernel actually writes: the hierarchy fields come before the
    // path, so matching on "/system.slice" alone would never fire.
    expect(classifyCgroup('0::/system.slice/dsh-web.service')).toEqual({
      scope: 'system',
      unit: 'dsh-web.service',
    });
    expect(classifyCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service')).toEqual({
      scope: 'user',
      unit: 'dsh-web.service',
    });
    // cgroup v1 names the controllers instead of leaving the field empty.
    expect(classifyCgroup('4:systemd:/system.slice/dsh-web.service')).toEqual({
      scope: 'system',
      unit: 'dsh-web.service',
    });
    expect(classifyCgroup('0::/system.slice/system-dsh.slice/dsh-web-dev.service')).toEqual({
      scope: 'system',
      unit: 'dsh-web-dev.service',
    });
    for (const text of [
      '0::/init.scope',
      '0::/',
      '0::/system.slice',
      '0::/system.slice/not-a-unit',
      '0::/system.slice/../../etc/shadow.service',
      'garbage',
      '',
    ]) {
      expect(classifyCgroup(text).unit).toBeNull();
    }
  });

  it('reports a system-scope unit, a user-scope unit and a hand-started process', () => {
    expect(parseManagedReport(marker('path=/system.slice/dsh-web.service unit=dsh-web.service user=triag'))).toEqual({
      scope: 'system',
      unit: 'dsh-web.service',
      user: 'triag',
    });
    expect(
      parseManagedReport(
        marker('path=/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-web.service unit=dsh-web.service user=triag'),
      ),
    ).toEqual({ scope: 'user', unit: 'dsh-web.service', user: 'triag' });
    expect(parseManagedReport(marker('path=/init.scope unit=- user=triag'))).toEqual({
      scope: 'none',
      unit: null,
      user: 'triag',
    });
  });

  it('treats noise, a missing reply and a hostile unit name as "no manager"', () => {
    for (const text of [
      '',
      'systemctl: command not found',
      marker('path=/system.slice/../../etc/shadow.service unit=../../evil user=triag'),
      marker('path=/system.slice/dsh-web.service unit=other.service user=triag'),
      marker('path=/system.slice/dsh-web.service user=bad user'),
      marker('path=/system.slice/dsh-web.service unit=dsh-web.service'),
    ]) {
      const report = parseManagedReport(text);
      expect({ scope: report.scope, unit: report.unit }).toEqual({ scope: 'none', unit: null });
    }
    // The quoting user is still reported when the reply itself was well formed.
    expect(parseManagedReport(marker('path=/init.scope unit=- user=triag')).user).toBe('triag');
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

  it('never asks for privileges or controls anything', () => {
    expect(PROBE_MANAGED_SCRIPT).not.toContain('sudo');
    expect(PROBE_MANAGED_SCRIPT).not.toContain('systemctl');
    expect(PROBE_MANAGED_SCRIPT).not.toMatch(/\b(kill|start|stop|restart|enable|disable)\b/);
    expect(PROBE_MANAGED_SCRIPT).not.toMatch(/eval|\$\(\(/);
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
    } else {
      expect(report.unit).toMatch(/\.service$/);
    }
  });

  itLinux('rejects a pid that does not exist', () => {
    const run = spawnSync('/bin/sh', ['-c', PROBE_MANAGED_SCRIPT, 'not-a-pid'], { encoding: 'utf8' });
    expect(run.status).toBe(64);
    expect(run.stderr).toContain('rejected pid');
  });
});
