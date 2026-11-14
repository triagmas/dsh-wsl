/**
 * Read-only installation inspection.
 *
 * The script that replaced the updater must stay read-only: it may report paths,
 * versions, manager and processes, but it must not install, stop or write.
 */
import { describe, expect, it } from 'vitest';
import { ArgumentError } from '../src/main/wsl/args.js';
import { INSPECT_SCRIPT, buildInspectArgs } from '../src/main/wsl/inspect.js';

describe('inspection arguments', () => {
  it('builds a read-only command with explicit positionals', () => {
    expect(
      buildInspectArgs({
        distro: 'Ubuntu',
        appRoot: '/home/triag/.local/share/wsl-web-shell',
        dshPath: '/usr/local/bin/dsh',
        nodePath: '/usr/bin/node',
        ownPid: 194,
      }),
    ).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      '/bin/sh',
      '-c',
      INSPECT_SCRIPT,
      '/usr/local/bin/dsh',
      '/home/triag/.local/share/wsl-web-shell',
      '/usr/bin/node',
      '194',
    ]);
  });

  it('lets the script resolve the executable when none is configured', () => {
    const args = buildInspectArgs({ distro: 'Ubuntu', appRoot: '', dshPath: null, nodePath: null, ownPid: null });
    expect(args.slice(6)).toEqual(['-', '-', '-', '-']);
  });

  it('rejects values that could change the command', () => {
    expect(() => buildInspectArgs({ distro: '', appRoot: '-', dshPath: null, nodePath: null, ownPid: null })).toThrow(
      ArgumentError,
    );
    expect(() =>
      buildInspectArgs({ distro: 'Ubuntu', appRoot: '-', dshPath: '/tmp/dsh; rm -rf /', nodePath: null, ownPid: null }),
    ).toThrow(ArgumentError);
    expect(() =>
      buildInspectArgs({ distro: 'Ubuntu', appRoot: '-', dshPath: '../dsh', nodePath: null, ownPid: null }),
    ).toThrow(ArgumentError);
    expect(() =>
      buildInspectArgs({ distro: 'Ubuntu', appRoot: '-', dshPath: null, nodePath: null, ownPid: -1 }),
    ).toThrow(ArgumentError);
  });

  it('only reads the installation', () => {
    for (const forbidden of ['sudo', 'systemctl', 'npm install', 'pnpm add', 'rm -rf', 'curl', 'wget', 'kill ']) {
      expect(INSPECT_SCRIPT).not.toContain(forbidden);
    }
  });
});
