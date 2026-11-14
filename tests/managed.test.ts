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
  INSTALL_RULE_SCRIPT,
  PROBE_MANAGED_SCRIPT,
  buildControlManagedArgs,
  buildInstallRuleArgs,
  buildProbeManagedArgs,
  buildRootRuleScript,
  parseInstallRuleReport,
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

describe('one-password rule install', () => {
  it('never puts the password in the argument list', () => {
    // Anything in argv is readable by every process on the machine, so the
    // password has to travel on the stdin pipe of the WSL command.
    const argv = buildInstallRuleArgs({ distro: 'Ubuntu', user: 'triag', unit: 'dsh-web.service' });
    expect(argv.slice(0, 6)).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', INSTALL_RULE_SCRIPT]);
    expect(argv).toHaveLength(7);
    // The only extra argument is the already validated root script.
    expect(argv[6]).toContain('/etc/sudoers.d/dsh-update');
    // The password is read from stdin, not from a positional argument.
    expect(INSTALL_RULE_SCRIPT).not.toContain('$1');
    expect(INSTALL_RULE_SCRIPT).toContain('IFS= read -r dsh_pass');
    expect(INSTALL_RULE_SCRIPT).toContain('sudo -S -p ""');
    // The password is only handed to sudo's stdin, never echoed.
    expect(INSTALL_RULE_SCRIPT).not.toMatch(/echo \$dsh_pass/);
  });

  it('installs exactly the rule it advertises', () => {
    const root = buildRootRuleScript({ user: 'triag', unit: 'dsh-web.service' });
    const rule = sudoersLines({ user: 'triag', unit: 'dsh-web.service' })[0] ?? '';
    expect(root).toContain(rule);
    expect(root).toContain('/etc/sudoers.d/dsh-update');
    expect(root).toContain('chmod 0440');
    expect(root).toContain('visudo -c');
    // A rejected file is removed instead of left behind.
    expect(root).toContain('rm -f /etc/sudoers.d/dsh-update');
  });

  it('refuses to build a root script from unvalidated text', () => {
    expect(() => buildRootRuleScript({ user: 'triag; rm -rf /', unit: 'dsh-web.service' })).toThrow(ArgumentError);
    expect(() => buildRootRuleScript({ user: 'triag', unit: 'dsh-web.service\nroot ALL=(ALL) ALL' })).toThrow(
      ArgumentError,
    );
    expect(() => buildInstallRuleArgs({ distro: 'Ubuntu', user: 'triag', unit: '../evil.service' })).toThrow(
      ArgumentError,
    );
  });

  it('reads the marker and reports failures with their own words', () => {
    expect(parseInstallRuleReport('__dsh_wsl_managed__ ok=1 unit=dsh-web.service')).toEqual({
      ok: true,
      message: null,
    });
    expect(parseInstallRuleReport('rule: the sudoers syntax check failed, the file was removed')).toEqual({
      ok: false,
      message: 'rule: the sudoers syntax check failed, the file was removed',
    });
    expect(parseInstallRuleReport('')).toEqual({ ok: false, message: null });
  });
});
