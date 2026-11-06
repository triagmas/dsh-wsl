/**
 * Issue #8: one workspace contract for Settings and the launcher.
 *
 * A value that Settings accepts must survive `assertWorkspace` and vice versa;
 * trailing slashes are normalised instead of being accepted then rejected.
 */
import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath, WORKSPACE_MAX_LENGTH } from '../src/main/core/workspace.js';
import { applyConfigPatch, normalizeConfig, requiresRestart } from '../src/main/core/config.js';
import { DEFAULT_CONFIG } from '../src/shared/types.js';
import { ArgumentError, assertWorkspace } from '../src/main/wsl/args.js';

const accepted: Array<[string, string]> = [
  ['~', '~'],
  ['~/', '~'],
  ['~//', '~'],
  ['~/projects', '~/projects'],
  ['~/projects/', '~/projects'],
  ['~/projects///', '~/projects'],
  ['/home/user', '/home/user'],
  ['/home/user/', '/home/user'],
  ['/mnt/f/code/wsl-web-shell/', '/mnt/f/code/wsl-web-shell'],
  ['  /home/user/  ', '/home/user'],
];

const rejected = [
  '',
  '   ',
  '/',
  '//',
  '~user/projects',
  'projects',
  './projects',
  '/home/user/../projects',
  '/home/user/./projects',
  '/home//user',
  '/home/user\\projects',
  '/home/user\0',
  '/home/user\nprojects',
  `/${'a/'.repeat(WORKSPACE_MAX_LENGTH)}`,
];

describe('normalizeWorkspacePath', () => {
  it.each(accepted)('normalises %j to %j', (input, expected) => {
    expect(normalizeWorkspacePath(input)).toBe(expected);
  });

  it.each(rejected)('rejects %j', (input) => {
    expect(normalizeWorkspacePath(input)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeWorkspacePath(null)).toBeNull();
    expect(normalizeWorkspacePath(42)).toBeNull();
    expect(normalizeWorkspacePath(['/home/user'])).toBeNull();
  });
});

describe('Settings and launcher agree', () => {
  it.each(accepted)('%j is accepted by Settings and by the launcher', (input, expected) => {
    const result = applyConfigPatch(DEFAULT_CONFIG, { workspace: input });
    expect(result.errors).toEqual([]);
    expect(result.config.workspace).toBe(expected);
    expect(assertWorkspace(input)).toBe(expected);
    expect(assertWorkspace(result.config.workspace)).toBe(expected);
  });

  it.each(rejected)('%j is rejected by Settings and by the launcher', (input) => {
    expect(applyConfigPatch(DEFAULT_CONFIG, { workspace: input }).errors).toEqual([
      'workspace: expected an absolute POSIX path such as /home/user/projects',
    ]);
    expect(() => assertWorkspace(input)).toThrow(ArgumentError);
  });

  it('normalises a legacy persisted value instead of rejecting the config', () => {
    expect(normalizeConfig({ workspace: '/home/user/projects/' }).workspace).toBe('/home/user/projects');
    expect(normalizeConfig({ workspace: 'broken' }).workspace).toBe(DEFAULT_CONFIG.workspace);
  });

  it('treats a trailing-slash-only edit as no change (no spurious restart)', () => {
    const current = { ...DEFAULT_CONFIG, workspace: '/home/user/projects' };
    const result = applyConfigPatch(current, { workspace: '/home/user/projects/' });
    expect(result.changed).toBe(false);
    expect(requiresRestart(current, result.config)).toBe(false);
  });
});
