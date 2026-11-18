/**
 * Console update script and result (beta.13, hardened in beta.14).
 *
 * The script is the only thing the app executes, so these tests pin what it may
 * contain: the plan's commands, one password prompt up front, a log, a start that
 * runs after a successful stop, a trap for a closed window, and nothing an owner
 * could not read in the window before clicking the button.
 */
import { describe, expect, it } from 'vitest';
import type { DshInstallation } from '../src/main/core/dsh-locate.js';
import { buildManualUpdatePlan } from '../src/main/core/manual-update.js';
import {
  UPDATE_LOG_DIR,
  asCommandList,
  buildUpdateLogPath,
  buildUpdateResult,
  buildUpdateScript,
  planRunsInConsole,
  sameCommands,
} from '../src/main/core/update-console.js';

const STAMP = '2026-08-20T10-11-12-345Z';
const LOG = `~/${UPDATE_LOG_DIR}/update-${STAMP}.log`;
const INSTALL = '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.2';
const STOP = 'sudo systemctl stop dsh-web.service';
const START = 'sudo systemctl start dsh-web.service';

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
    loginShellRealPath: null,
    loginShellVersion: null,
    ...overrides,
  };
}

describe('log path', () => {
  it('builds one path per run from the timestamp', () => {
    expect(buildUpdateLogPath(STAMP)).toBe(LOG);
  });

  it('refuses a timestamp that could escape the directory', () => {
    for (const stamp of ['', '../x', '2026-08-20 10:11:12', '2026-08-20T10:11:12Z;rm -rf /', null]) {
      expect(buildUpdateLogPath(stamp as string)).toBeNull();
    }
  });
});

describe('console script', () => {
  it('echoes, tees, keeps the first failing status and waits for Enter', () => {
    const script = buildUpdateScript([INSTALL], LOG);
    expect(script).not.toBeNull();
    const text = script as string;
    expect(text).toContain(`LOG="$HOME/${UPDATE_LOG_DIR}/update-${STAMP}.log"`);
    expect(text).toContain('exec > >(tee -a "$LOG") 2>&1');
    expect(text).toContain(`run '${INSTALL}'`);
    expect(text).toContain('read -r _');
    expect(text).toContain('exit "$fail"');
  });

  it('asks for the password once, before the stop, and only when sudo is needed', () => {
    const withSudo = buildUpdateScript([STOP, INSTALL, START], LOG) as string;
    const prompt = withSudo.indexOf("run 'sudo -v'");
    const stop = withSudo.indexOf(`run '${STOP}'`);
    expect(prompt).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(prompt);
    // A refused password leaves `fail` set, so the stop never runs.
    expect(withSudo.split('\n').find((line) => line.includes("run 'sudo -v'"))).toContain('if [ "$fail" -eq 0 ]');

    const withoutSudo = buildUpdateScript([INSTALL], LOG) as string;
    expect(withoutSudo).not.toContain('sudo -v');
  });

  it('puts the resolved Node.js on PATH so a `#!/usr/bin/env node` npm can start', () => {
    const text = buildUpdateScript([INSTALL], LOG, {
      nodePath: '/home/triag/.hermes/node/bin/node',
    }) as string;
    expect(text).toContain('export PATH=\'/home/triag/.hermes/node/bin\':"$PATH"');
    const exported = text.indexOf('export PATH=');
    const install = text.indexOf(`run '${INSTALL}'`);
    expect(install).toBeGreaterThan(exported);

    // Without a usable path the script must not invent one - and says so, because
    // the only other symptom is `node: not found` halfway through the install.
    const unknown = buildUpdateScript([INSTALL], LOG) as string;
    expect(unknown).not.toContain('export PATH=');
    expect(unknown).toContain('note: node directory unknown, PATH unchanged');
    const note = unknown.indexOf('note: node directory unknown');
    expect(unknown.indexOf(`run '${INSTALL}'`)).toBeGreaterThan(note);

    expect(buildUpdateScript([INSTALL], LOG, { nodePath: 'node' })).toContain('note: node directory unknown');
    expect(buildUpdateScript([INSTALL], LOG, { nodePath: "/home/x/it's/node" })).toContain('note: node directory unknown');
    // A usable directory prints the note only in its own branch, never both.
    expect(text).not.toContain('note: node directory unknown');
  });

  it('runs the start line after the unit was stopped, even when the install fails', () => {
    const text = buildUpdateScript([STOP, INSTALL, START], LOG) as string;
    const lines = text.split('\n');
    expect(text).toContain(`START='${START}'`);
    const stop = lines.findIndex((line) => line.includes(`run '${STOP}'`));
    const install = lines.findIndex((line) => line.includes('@deepseek-ai/dsh@0.2.2'));
    const bringBack = lines.findIndex((line) => line.trim() === 'bring_back');
    expect(stop).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(stop);
    expect(bringBack).toBeGreaterThan(install);
    // `stopped` is only set by a successful stop, which is what the recovery
    // start is conditioned on.
    expect(lines[stop]).toContain('then stopped=1');
    expect(text).toContain('if [ -z "$START" ] || [ "$stopped" -ne 1 ] || [ "$started" -ne 0 ]');
  });

  it('catches a closed window or Ctrl-C and tries the start line from a trap', () => {
    const text = buildUpdateScript([STOP, INSTALL, START], LOG) as string;
    expect(text).toContain('trap on_signal INT TERM HUP');
    expect(text).toContain('trap bring_back EXIT');
    expect(text).toContain('exit 130');
    // The trap owns the last word: it says the service may still be down and
    // prints the line the owner has to run themselves, with the log path.
    expect(text).toContain('The service is still stopped');
    expect(text).toContain('Run this in a WSL terminal');
    // No guessed cause: a closed window is only one of several reasons a failed
    // start can have, and the script cannot tell which one it was.
    expect(text).not.toContain('closed window');
    expect(text).not.toContain('cannot ask for the password');
  });

  it('runs a plan with only the install line and no phantom start', () => {
    const text = buildUpdateScript([INSTALL], LOG) as string;
    expect(text).not.toContain('systemctl start');
    expect(text).toContain("START=''");
  });

  it('refuses text the shell would reinterpret', () => {
    expect(buildUpdateScript([], LOG)).toBeNull();
    expect(buildUpdateScript([INSTALL], 'relative.log')).toBeNull();
    expect(buildUpdateScript(["echo 'quoted'"], LOG)).toBeNull();
    expect(buildUpdateScript(['echo one\necho two'], LOG)).toBeNull();
    expect(buildUpdateScript([''], LOG)).toBeNull();
  });
});

describe('console result', () => {
  it('reports success from the version, not the exit code', () => {
    const result = buildUpdateResult({
      code: 1,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.2',
      target: '0.2.2',
      installation: installation(),
      backend: 'READY',
    });
    expect(result.success).toBe(true);
    expect(result.rollbackCommand).toBeNull();
    expect(result.message).toContain('0.2.2');
    expect(result.message).toContain('The backend is running again');
  });

  it('does not claim the backend is back when the supervisor is still recovering', () => {
    const result = buildUpdateResult({
      code: 0,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.2',
      target: '0.2.2',
      installation: installation(),
      backend: 'RECOVERING',
    });
    expect(result.success).toBe(true);
    expect(result.message).not.toContain('running again');
    expect(result.message).toContain('RECOVERING');
  });

  it('offers the rollback line when the installation did not move', () => {
    const result = buildUpdateResult({
      code: 1,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.1',
      target: '0.2.2',
      installation: installation(),
      backend: 'ERROR',
    });
    expect(result.success).toBe(false);
    expect(result.rollbackCommand).toBe(
      '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.1',
    );
    expect(result.message).toContain('0.2.1');
    expect(result.message).not.toContain('running again');
    expect(result.message).toContain('ERROR');
  });

  it('says the backend state is unknown when it could not be read', () => {
    const result = buildUpdateResult({
      code: 0,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.2',
      target: '0.2.2',
      installation: installation(),
      backend: null,
    });
    expect(result.message).toContain('unknown');
    expect(result.message).not.toContain('running again');
  });

  it('reports a console that never started, and changes nothing', () => {
    const result = buildUpdateResult({
      code: null,
      logPath: LOG,
      before: '0.2.1',
      after: '0.2.1',
      target: '0.2.2',
      installation: installation(),
      backend: 'READY',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('could not be started');
    expect(result.rollbackCommand).not.toBeNull();
  });

  it('does not claim success when the version cannot be read back', () => {
    const result = buildUpdateResult({
      code: 0,
      logPath: LOG,
      before: '0.2.1',
      after: null,
      target: '0.2.2',
      installation: installation(),
      backend: 'READY',
    });
    expect(result.success).toBe(false);
    expect(result.message).toContain('could not be read');
    // The previous version is known, so a "go back" line is still offered.
    expect(result.rollbackCommand).toBe(
      '"/usr/bin/npm" install -g --prefix "/home/triag/.npm-global" @deepseek-ai/dsh@0.2.1',
    );
  });
});

describe('plan gate', () => {
  it('only a pending plan with commands and a console marker runs', () => {
    const pending = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'none',
      unit: null,
    });
    expect(planRunsInConsole(pending)).toBe(true);
    const attached = buildManualUpdatePlan({
      installation: installation(),
      target: '0.2.2',
      backend: 'attached',
      unit: null,
    });
    expect(planRunsInConsole(attached)).toBe(false);
  });
});

describe('stale window guard', () => {
  it('accepts only a plausible list of command strings', () => {
    expect(asCommandList([INSTALL])).toEqual([INSTALL]);
    expect(asCommandList([])).toBeNull();
    expect(asCommandList('npm install')).toBeNull();
    expect(asCommandList([1])).toBeNull();
    expect(asCommandList([''])).toBeNull();
    expect(asCommandList(['echo one\necho two'])).toBeNull();
    expect(asCommandList(new Array(21).fill(INSTALL))).toBeNull();
  });

  it('compares the list in order, not by membership', () => {
    expect(sameCommands([STOP, INSTALL, START], [STOP, INSTALL, START])).toBe(true);
    expect(sameCommands([STOP, INSTALL, START], [INSTALL, STOP, START])).toBe(false);
    expect(sameCommands([INSTALL], [INSTALL, START])).toBe(false);
    expect(sameCommands([], [])).toBe(true);
  });
});
