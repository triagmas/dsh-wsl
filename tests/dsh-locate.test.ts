/**
 * Issue #17 — parsing the read-only provenance report.
 *
 * The report is the only evidence the app has about which `dsh` it runs and how
 * that file is managed, so a report it cannot fully trust must resolve to
 * "not found" instead of a guess: the update policy then fails closed.
 */
import { describe, expect, it } from 'vitest';
import {
  INSPECT_MARKER,
  describeInstallScope,
  describeInstallation,
  isInsideDirectory,
  isNpmGlobalInstallation,
  loginShellAgrees,
  parseSharedDshReport,
  type DshInstallation,
} from '../src/main/core/dsh-locate.js';

const PREFIX = '/home/dev/.npm-global';
const PKG = `${PREFIX}/lib/node_modules/@deepseek-ai/dsh`;

function report(fields: Record<string, string>, extra: string[] = []): string {
  return [
    ...Object.entries({ found: 'yes', ...fields }).map(([key, value]) => `${INSPECT_MARKER} ${key}=${value}`),
    ...extra,
  ].join('\n');
}

const base: Record<string, string> = {
  path: `${PREFIX}/bin/dsh`,
  real: `${PKG}/bin/dsh.js`,
  link: 'yes',
  source: 'login-shell',
  version: '0.2.1-rc.5',
  npm: '/usr/bin/npm',
  manager: 'npm',
  prefix: PREFIX,
  package: PKG,
  writable: 'yes',
  foreign: '0',
  loginreal: `${PKG}/bin/dsh.js`,
  loginversion: '0.2.1-rc.5',
};

function installation(overrides: Partial<DshInstallation> = {}): DshInstallation {
  return {
    path: `${PREFIX}/bin/dsh`,
    realPath: `${PKG}/bin/dsh.js`,
    symlink: true,
    version: '0.2.1-rc.5',
    manager: 'npm',
    prefix: PREFIX,
    packageDir: PKG,
    writable: true,
    npmPath: '/usr/bin/npm',
    source: 'login-shell',
    foreignProcesses: 0,
    loginShellRealPath: `${PKG}/bin/dsh.js`,
    loginShellVersion: '0.2.1-rc.5',
    ...overrides,
  };
}

describe('provenance report parsing', () => {
  it('parses a complete npm global report', () => {
    const parsed = parseSharedDshReport(report(base, ['noise line', 'update: something']));
    expect(parsed.found).toBe(true);
    expect(parsed.installation).toEqual({
      path: `${PREFIX}/bin/dsh`,
      realPath: `${PKG}/bin/dsh.js`,
      symlink: true,
      version: '0.2.1-rc.5',
      manager: 'npm',
      prefix: PREFIX,
      packageDir: PKG,
      writable: true,
      npmPath: '/usr/bin/npm',
      source: 'login-shell',
      foreignProcesses: 0,
      loginShellRealPath: `${PKG}/bin/dsh.js`,
      loginShellVersion: '0.2.1-rc.5',
    });
  });

  it('reports a missing installation without inventing a path', () => {
    const parsed = parseSharedDshReport(`${INSPECT_MARKER} legacy=no\n${INSPECT_MARKER} found=no`);
    expect(parsed).toEqual({ found: false, installation: null, legacyRuntimePresent: false });
  });

  it('reports that an older private runtime still exists', () => {
    const parsed = parseSharedDshReport(`${INSPECT_MARKER} legacy=yes\n${INSPECT_MARKER} found=no`);
    expect(parsed.found).toBe(false);
    expect(parsed.legacyRuntimePresent).toBe(true);
  });

  it('refuses a report whose paths are not absolute', () => {
    expect(parseSharedDshReport(report({ ...base, real: 'lib/dsh.js' })).installation).toBeNull();
    expect(parseSharedDshReport(report({ ...base, path: './bin/dsh' })).installation).toBeNull();
    expect(parseSharedDshReport(report({ ...base, real: '/a/../b' })).installation).toBeNull();
  });

  it('refuses marker values that could be shell text', () => {
    const parsed = parseSharedDshReport(report({ ...base, path: '/home/dev/$(id)/bin/dsh' }));
    expect(parsed.installation).toBeNull();
  });

  it('normalises unknown managers, sources and counts', () => {
    const parsed = parseSharedDshReport(
      report({ ...base, manager: 'bun', source: 'weird', foreign: 'many', writable: 'maybe' }),
    );
    expect(parsed.installation?.manager).toBe('unknown');
    expect(parsed.installation?.source).toBe('fallback');
    expect(parsed.installation?.foreignProcesses).toBe(0);
    expect(parsed.installation?.writable).toBe(false);
  });

  it('treats a pnpm report as its own manager', () => {
    const parsed = parseSharedDshReport(report({ ...base, manager: 'pnpm', prefix: '/home/dev/.local/share/pnpm/global/5' }));
    expect(parsed.installation?.manager).toBe('pnpm');
    expect(isNpmGlobalInstallation(parsed.installation as DshInstallation)).toBe(false);
  });

  it('accepts the classic global layout as well', () => {
    const parsed = parseSharedDshReport(report({ ...base, prefix: '/usr/local', package: '/usr/local/lib/node_modules/@deepseek-ai/dsh', real: '/usr/local/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js' }));
    expect(parsed.installation).not.toBeNull();
    expect(isNpmGlobalInstallation(parsed.installation as DshInstallation)).toBe(true);
  });
});

describe('path containment', () => {
  it('requires a real directory boundary', () => {
    expect(isInsideDirectory(`${PKG}/bin/dsh.js`, PKG)).toBe(true);
    expect(isInsideDirectory(PKG, PKG)).toBe(true);
    expect(isInsideDirectory(`${PKG}-old/bin/dsh.js`, PKG)).toBe(false);
    expect(isInsideDirectory('/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh2/bin', PKG)).toBe(false);
  });

  it('rejects anything that is not an absolute path', () => {
    expect(isInsideDirectory('relative', PKG)).toBe(false);
    expect(isInsideDirectory(PKG, null)).toBe(false);
    expect(isInsideDirectory(null, PKG)).toBe(false);
  });
});

describe('installation classification', () => {
  it('accepts the expected npm layout only', () => {
    expect(isNpmGlobalInstallation(installation())).toBe(true);
    expect(isNpmGlobalInstallation(installation({ manager: 'pnpm' }))).toBe(false);
    expect(isNpmGlobalInstallation(installation({ realPath: '/usr/local/bin/dsh' }))).toBe(false);
    expect(isNpmGlobalInstallation(installation({ packageDir: `${PKG}-old`, realPath: `${PKG}-old/bin/dsh.js` }))).toBe(false);
    expect(isNpmGlobalInstallation(installation({ packageDir: null }))).toBe(false);
  });

  it('describes the installation scope for the UI', () => {
    expect(describeInstallScope(PREFIX)).toBe(`user (${PREFIX})`);
    expect(describeInstallScope('/usr/local')).toBe('system-wide (/usr/local)');
    expect(describeInstallScope('/opt/node')).toBe('system-wide (/opt/node)');
    expect(describeInstallScope(null)).toBe('unknown');
  });

  it('summarises the installation without leaking anything else', () => {
    const text = describeInstallation(installation());
    expect(text).toContain(`${PREFIX}/bin/dsh`);
    expect(text).toContain('0.2.1-rc.5');
    expect(text).toContain('npm');
    expect(text).toContain('source=login-shell');
  });
});

describe('login shell agreement (issue #17 review B3)', () => {
  it('accepts an installation a login shell resolves as well', () => {
    expect(loginShellAgrees(installation())).toBe(true);
  });

  it('rejects an installation the terminal would not run', () => {
    expect(loginShellAgrees(installation({ loginShellRealPath: '/home/dev/other/bin/dsh' }))).toBe(false);
  });

  it('never treats an unresolvable login shell as agreement (C1)', () => {
    // No bash, no `dsh` on the shell PATH or an unreadable profile: unknown is
    // not agreement, so the update must be refused.
    expect(loginShellAgrees(installation({ loginShellRealPath: null }))).toBe(false);
    expect(loginShellAgrees(installation({ loginShellVersion: null }))).toBe(false);
    expect(loginShellAgrees(installation({ loginShellVersion: '0.2.0' }))).toBe(false);
    expect(loginShellAgrees(installation({ version: null }))).toBe(false);
  });

  it('parses the login-shell fields and ignores malformed ones', () => {
    const parsed = parseSharedDshReport(report(base));
    expect(parsed.installation?.loginShellRealPath).toBe(`${PKG}/bin/dsh.js`);
    expect(parsed.installation?.loginShellVersion).toBe('0.2.1-rc.5');
    // A value the app cannot trust is dropped instead of becoming a path.
    const broken = parseSharedDshReport(
      report({ ...base, loginreal: '/home/dev/with space/dsh', loginversion: 'nonsense version' }),
    );
    expect(broken.installation?.loginShellRealPath).toBeNull();
    expect(broken.installation?.loginShellVersion).toBeNull();
    // The installation itself is still usable, but the update is refused: a shell
    // value the app cannot trust cannot prove the terminal runs the same file.
    expect(broken.installation?.realPath).toBe(`${PKG}/bin/dsh.js`);
    expect(loginShellAgrees(broken.installation as DshInstallation)).toBe(false);
  });
});
