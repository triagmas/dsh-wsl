/**
 * The console script, executed for real (beta.14).
 *
 * `update-console.test.ts` pins the text; this file runs the generated script
 * with fake `sudo`, `systemctl` and `npm` on PATH, so the behaviour the window
 * promises is checked rather than asserted: the password is asked before the
 * stop, a failed install still starts the service, a closed window is caught by
 * the trap, and npm's `#!/usr/bin/env node` shebang needs the resolved Node.js.
 *
 * Nothing here touches a real service: every command is a fake in a temp dir.
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UPDATE_LOG_DIR, buildUpdateScript } from '../src/main/core/update-console.js';

const BASH = existsSync('/bin/bash') ? '/bin/bash' : null;
const skip = BASH === null || process.platform === 'win32';
const ROOT = join(process.cwd(), '.tmp-script-test');
const STAMP = '2026-08-20T10-11-12-345Z';
const LOG = `~/${UPDATE_LOG_DIR}/update-${STAMP}.log`;
const STOP = 'sudo systemctl stop dsh-web.service';
const START = 'sudo systemctl start dsh-web.service';

let counter = 0;

interface Sandbox {
  root: string;
  home: string;
  bin: string;
  record: string;
  npm: string;
  /** A PATH containing only the tools the script needs, or `null` for the host PATH. */
  tools: string | null;
}

const NEEDED_TOOLS = ['mkdir', 'tee', 'sleep'] as const;

/** Absolute path of a real host tool, so a hermetic PATH needs no `/usr/bin`. */
function systemTool(name: string): string | null {
  for (const dir of ['/bin', '/usr/bin']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Fake command, fake HOME and a record file; no real system command is used. */
function sandbox(
  options: {
    sudoFails?: boolean;
    npmSleep?: string;
    envNodeNpm?: boolean;
    withoutNode?: boolean;
    /** Build a PATH with only the tools the script needs and no host `node`. */
    hermetic?: boolean;
    /** Make `systemctl start` fail, like a unit that refuses to come back. */
    systemctlStartFails?: boolean;
  } = {},
): Sandbox {
  counter += 1;
  const root = join(ROOT, `case-${counter}`);
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const record = join(root, 'record.log');
  const write = (name: string, body: string): string => {
    const path = join(bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };

  write(
    'sudo',
    `#!/bin/sh
echo "sudo $*" >> "${record}"
if [ "$1" = "-v" ]; then exit ${options.sudoFails === true ? '1' : '0'}; fi
exec "$@"
`,
  );
  write(
    'systemctl',
    `#!/bin/sh
echo "systemctl $*" >> "${record}"
if [ "${options.systemctlStartFails === true ? 'yes' : 'no'}" = yes ] && [ "$1" = "start" ]; then exit 1; fi
exit 0
`,
  );
  const npm = write(
    'npm',
    options.envNodeNpm === true
      ? `#!/usr/bin/env node
require('node:fs').appendFileSync('${record}', 'npm ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`
      : `#!/bin/sh
echo "npm $*" >> "${record}"
sleep ${options.npmSleep ?? '0'}
exit 1
`,
  );
  let tools: string | null = null;
  if (options.hermetic === true) {
    tools = join(root, 'tools');
    mkdirSync(tools, { recursive: true });
    for (const name of NEEDED_TOOLS) {
      const source = systemTool(name);
      if (source !== null) symlinkSync(source, join(tools, name));
    }
  }
  if (options.withoutNode !== true) {
    write(
      'node',
      `#!/bin/sh
echo "node $*" >> "${record}"
exit 0
`,
    );
  }
  return { root, home, bin, record, npm, tools };
}

function runScript(sandboxed: Sandbox, commands: string[], nodePath?: string): { code: number | null; output: string } {
  const script = buildUpdateScript(commands, LOG, nodePath === undefined ? {} : { nodePath });
  expect(script).not.toBeNull();
  const path = join(sandboxed.root, 'update.sh');
  writeFileSync(path, script as string);
  const result = spawnSync(BASH as string, [path], {
    cwd: sandboxed.root,
    env: {
      HOME: sandboxed.home,
      PATH: sandboxed.tools === null ? `${sandboxed.bin}:/usr/bin:/bin` : `${sandboxed.bin}:${sandboxed.tools}`,
      TERM: 'dumb',
    },
    encoding: 'utf8',
    input: '\n',
    timeout: 15_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function recorded(sandboxed: Sandbox): string[] {
  if (!existsSync(sandboxed.record)) return [];
  return readFileSync(sandboxed.record, 'utf8').split('\n').filter((line) => line !== '');
}

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe.skipIf(skip)('console script, executed', () => {
  it('is valid bash for every plan shape', () => {
    const box = sandbox();
    const shapes: [string[], string | undefined][] = [
      [[`"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`], undefined],
      [[STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START], undefined],
      [[STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START], '/usr/local/bin/node'],
      [['systemctl --user stop dsh-web.service', `"${box.npm}" install -g x`, 'systemctl --user start dsh-web.service'], undefined],
      [["sudo env \"PATH=$PATH\" npm install -g x"], undefined],
    ];
    for (const [commands, nodePath] of shapes) {
      const script = buildUpdateScript(commands, LOG, nodePath === undefined ? {} : { nodePath });
      expect(script).not.toBeNull();
      const path = join(box.root, 'syntax.sh');
      writeFileSync(path, script as string);
      const check = spawnSync(BASH as string, ['-n', path], { encoding: 'utf8' });
      expect(check.status, `${commands.join(' && ')}: ${check.stderr}`).toBe(0);
    }
  });

  it('asks for the password before stopping anything and starts again after a failed install', () => {
    const box = sandbox();
    const { code } = runScript(box, [STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START]);
    const lines = recorded(box);
    const sudoPrompt = lines.findIndex((line) => line === 'sudo -v');
    const stop = lines.findIndex((line) => line === 'systemctl stop dsh-web.service');
    const npm = lines.findIndex((line) => line.startsWith('npm install'));
    const start = lines.findIndex((line) => line === 'systemctl start dsh-web.service');
    expect(sudoPrompt).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(sudoPrompt);
    expect(npm).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(npm);
    // The install failed, so its status is what the console reports.
    expect(code).toBe(1);
  });

  it('leaves the service alone when the password is refused', () => {
    const box = sandbox({ sudoFails: true });
    const { code } = runScript(box, [STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START]);
    const lines = recorded(box);
    expect(lines).toContain('sudo -v');
    expect(lines.some((line) => line.startsWith('systemctl '))).toBe(false);
    expect(code).toBe(1);
  });

  it('starts the service from the trap when the window is closed mid-install', async () => {
    const box = sandbox({ npmSleep: '3' });
    const script = buildUpdateScript([STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START], LOG);
    const path = join(box.root, 'update.sh');
    writeFileSync(path, script as string);

    const child = spawn(BASH as string, [path], {
      cwd: box.root,
      env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, TERM: 'dumb' },
      stdio: 'ignore',
    });
    // Wait until the stop and the install are both under way, then hang up.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (recorded(box).some((line) => line.startsWith('npm install'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    child.kill('SIGHUP');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(() => resolve(), 5_000);
    });

    const lines = recorded(box);
    const stop = lines.findIndex((line) => line === 'systemctl stop dsh-web.service');
    const start = lines.findIndex((line) => line === 'systemctl start dsh-web.service');
    expect(stop).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(stop);
  }, 20_000);

  it('says the service is still stopped and prints the command, without guessing why', () => {
    const box = sandbox({ systemctlStartFails: true });
    const { code, output } = runScript(box, [STOP, `"${box.npm}" install -g @deepseek-ai/dsh@0.2.2`, START]);
    const lines = recorded(box);
    // The stop succeeded, the install failed, the recovery start failed too.
    expect(lines).toContain('systemctl stop dsh-web.service');
    expect(lines).toContain('systemctl start dsh-web.service');
    expect(code).toBe(1);

    expect(output).toContain('The service is still stopped. Run this in a WSL terminal:');
    expect(output).toContain(`  ${START}`);
    // The log path is printed next to the command, and no cause is asserted:
    // a closed window is only one of the ways a start can fail.
    expect(output).toContain(`log: ${box.home}/${UPDATE_LOG_DIR}/`);
    expect(output).not.toContain('closed window');
  });

  it('needs the resolved Node.js on PATH for a `#!/usr/bin/env node` npm', () => {
    const withNode = sandbox({ envNodeNpm: true });
    const nodeDir = join(withNode.root, 'node-bin');
    mkdirSync(nodeDir, { recursive: true });
    const node = join(nodeDir, 'node');
    writeFileSync(node, `#!/bin/sh\necho "node $*" >> "${withNode.record}"\nexit 0\n`);
    chmodSync(node, 0o755);

    const withResult = runScript(withNode, [`"${withNode.npm}" install -g @deepseek-ai/dsh@0.2.2`], `${nodeDir}/node`);
    // `env` found the fake node, which was handed the npm script: the shebang
    // resolved, which without the PATH line is exactly what fails.
    expect(recorded(withNode).some((line) => line.startsWith('node ') && line.includes('npm'))).toBe(true);
    expect(withResult.code).toBe(0);

    // Hermetic: the sandbox PATH holds only mkdir/tee/sleep, so a host `node`
    // in /usr/bin cannot make this pass. `/usr/bin/env` itself is absolute.
    const withoutNode = sandbox({ envNodeNpm: true, withoutNode: true, hermetic: true });
    expect(withoutNode.tools).not.toBeNull();
    expect(existsSync(join(withoutNode.tools as string, 'node'))).toBe(false);
    const withoutResult = runScript(withoutNode, [`"${withoutNode.npm}" install -g @deepseek-ai/dsh@0.2.2`]);
    expect(recorded(withoutNode).some((line) => line.startsWith('node '))).toBe(false);
    // The shebang cannot be resolved: `env` cannot find `node` anywhere on PATH.
    expect(withoutResult.output).toContain('node');
    expect(withoutResult.code).toBe(127);
    // The PATH line is missing, so the script says so before the commands.
    expect(withoutResult.output).toContain('note: node directory unknown, PATH unchanged');
  });
});
