/**
 * The inspection script, executed for real (issue #55).
 *
 * `INSPECT_SCRIPT` decides whether the manual update window can name a command, so
 * its prefix detection is checked against a sandbox with a fake `npm`, a fake
 * installation and a PATH holding only the tools the script itself uses. Nothing
 * here touches the real WSL installation, the network or the service.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { INSPECT_SCRIPT } from '../src/main/wsl/inspect.js';
import { parseSharedDshReport } from '../src/main/core/dsh-locate.js';

const SH = existsSync('/bin/sh') ? '/bin/sh' : null;
const skip = SH === null || process.platform === 'win32';

/** The script needs these and nothing else outside the shell builtins. */
const NEEDED_TOOLS = ['tr', 'sed', 'awk', 'head', 'tail', 'readlink'] as const;

const roots: string[] = [];

function hostTool(name: string): string | null {
  for (const dir of ['/usr/bin', '/bin']) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Sandbox {
  root: string;
  home: string;
  bin: string;
  dsh: string;
}

/**
 * A sandbox that looks like the owner's machine: the executable lives under
 * `~/.local/lib/node_modules`, while the npm the probe finds reports a *different*
 * global prefix (`~/.local/node`), exactly as after a Node.js reinstall.
 */
function sandbox(options: { npmPrefix: string; packagePrefix?: string | null }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'dsh-inspect-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'tools');
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const name of NEEDED_TOOLS) {
    const source = hostTool(name);
    if (source !== null) symlinkSync(source, join(bin, name));
  }

  // The npm shim only answers `prefix -g`; the real npm is never involved.
  const npm = join(home, '.local', 'bin', 'npm');
  writeFileSync(npm, `#!/bin/sh\nprintf '%s\\n' '${options.npmPrefix}'\n`);
  chmodSync(npm, 0o755);

  const dsh = join(home, '.local', 'bin', 'dsh');
  const packagePrefix = options.packagePrefix === undefined ? join(home, '.local') : options.packagePrefix;
  if (packagePrefix !== null) {
    // A real npm global install: `~/.local/bin/dsh` is a symlink into the package,
    // and that symlink is what proves ownership (`readlink -f` lands inside it).
    const pkg = join(packagePrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    const entry = join(pkg, 'lib', 'bin.js');
    writeFileSync(entry, "#!/bin/sh\nprintf 'dsh 0.2.2-rc.3\\n'\n");
    chmodSync(entry, 0o755);
    writeFileSync(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.3"}');
    symlinkSync(join('..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), dsh);
  } else {
    writeFileSync(dsh, "#!/bin/sh\nprintf 'dsh 0.2.2-rc.3\\n'\n");
    chmodSync(dsh, 0o755);
  }
  return { root, home, bin, dsh };
}

/**
 * Run the probe exactly like the launcher does: `/bin/sh -c <script> <want>
 * <appRoot> <node> <ownPid>`, so the first positional after the script is `$0`.
 */
function inspect(box: Sandbox, want: string = box.dsh): string {
  const result = spawnSync(SH as string, ['-c', INSPECT_SCRIPT, want, '-', '-', '-'], {
    env: { HOME: box.home, PATH: box.bin, TERM: 'dumb' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

/**
 * Create a real npm-style package under `prefix` and return the executable the
 * `dsh` symlink has to point at.
 */
function installAt(prefix: string): string {
  const pkg = join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  const entry = join(pkg, 'lib', 'bin.js');
  writeFileSync(entry, "#!/bin/sh\nprintf 'dsh 0.2.2-rc.3\\n'\n");
  chmodSync(entry, 0o755);
  writeFileSync(join(pkg, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.2-rc.3"}');
  return entry;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(skip)('inspection script prefix detection', () => {
  it('finds the installation when the npm prefix no longer contains it (issue #55)', () => {
    // The npm prefix is a real directory that does not hold the package; the
    // package lives in the classic per-user prefix instead, and the executable
    // the launcher runs points into that package.
    const box = sandbox({ npmPrefix: join(tmpdir(), 'dsh-inspect-npm-prefix') });

    const report = parseSharedDshReport(inspect(box));
    expect(report.found).toBe(true);
    expect(report.installation?.manager).toBe('npm');
    expect(report.installation?.prefix).toBe(join(box.home, '.local'));
    expect(report.installation?.packageDir).toBe(
      join(box.home, '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    );
    expect(report.installation?.writable).toBe(true);
  });

  it('keeps the manager unknown when the executable is outside every candidate', () => {
    const box = sandbox({ npmPrefix: join('/tmp', 'nowhere') });
    // A package exists under the candidate prefix, but the inspected executable
    // is not inside it: containment, not presence, decides.
    const outside = join(box.root, 'elsewhere', 'bin', 'dsh');
    mkdirSync(join(box.root, 'elsewhere', 'bin'), { recursive: true });
    writeFileSync(outside, "#!/bin/sh\nprintf 'dsh 0.2.2-rc.3\\n'\n");
    chmodSync(outside, 0o755);

    const report = parseSharedDshReport(inspect(box, outside));
    expect(report.found).toBe(true);
    expect(report.installation?.manager).toBe('unknown');
    // No package is attributed: the prefix npm reported is still reported as a
    // fact, but nothing claims the installation belongs to it.
    expect(report.installation?.packageDir).toBeNull();
  });

  it('still prefers the prefix npm reports when the package is inside it', () => {
    // Precedence, not just presence: a fallback candidate resolves to the *same*
    // real package directory here, so an implementation that tried the fallback
    // list first would report `~/.local` instead of npm's own prefix.
    const box = sandbox({ npmPrefix: join(tmpdir(), 'dsh-inspect-npm-prefix'), packagePrefix: null });
    const npmPrefix = join(box.root, 'npm');
    const entry = installAt(npmPrefix);
    rmSync(box.dsh, { force: true });
    symlinkSync(entry, box.dsh);
    writeFileSync(join(box.home, '.local', 'bin', 'npm'), `#!/bin/sh\nprintf '%s\\n' '${npmPrefix}'\n`);
    chmodSync(join(box.home, '.local', 'bin', 'npm'), 0o755);

    // `~/.local/lib/node_modules/@deepseek-ai/dsh` points at the very same package,
    // so containment holds for both candidates.
    mkdirSync(join(box.home, '.local', 'lib', 'node_modules', '@deepseek-ai'), { recursive: true });
    symlinkSync(
      join(npmPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
      join(box.home, '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
    );

    const report = parseSharedDshReport(inspect(box));
    expect(report.installation?.manager).toBe('npm');
    expect(report.installation?.prefix).toBe(npmPrefix);
    expect(report.installation?.packageDir).toBe(join(npmPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  });

  it('reports an unwritable fallback prefix as readonly', () => {
    // A root-owned fallback prefix still needs `sudo env "PATH=$PATH"` in the
    // install line, so writability has to follow the prefix that was found.
    const box = sandbox({ npmPrefix: join(tmpdir(), 'dsh-inspect-npm-prefix'), packagePrefix: null });
    const prefix = join(box.home, '.npm-global');
    const entry = installAt(prefix);
    rmSync(box.dsh, { force: true });
    symlinkSync(join(entry), box.dsh);

    chmodSync(prefix, 0o555);
    try {
      const report = parseSharedDshReport(inspect(box));
      expect(report.installation?.manager).toBe('npm');
      expect(report.installation?.prefix).toBe(prefix);
      expect(report.installation?.writable).toBe(false);
    } finally {
      chmodSync(prefix, 0o755);
    }
  });
});
