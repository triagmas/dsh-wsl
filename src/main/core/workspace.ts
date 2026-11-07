/**
 * Workspace path contract (pure).
 *
 * Settings and the launcher must agree on one rule set: a value that survives
 * Save has to survive the launch. A trailing slash is a conventional way to write
 * a directory, so it is accepted and normalised away; everything that could reach
 * outside the intended directory (relative paths, `..`, `.`, empty segments,
 * backslashes, control characters) stays rejected.
 */

export const WORKSPACE_MAX_LENGTH = 4096;

/**
 * Canonicalise a workspace path, or return `null` when it is not acceptable.
 *
 * - `~`, `~/`, `~/./` are not accepted (`~/./` has a `.` segment);
 * - `~/projects/`, `/mnt/f/code/` lose their trailing slashes;
 * - `/`, `~user/x`, `relative/path`, `/a//b`, `/a/../b` are rejected;
 * - whitespace-only values are rejected and never become `~`.
 */
export function normalizeWorkspacePath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '' || value.length > WORKSPACE_MAX_LENGTH) return null;
  if (/[\\\0\r\n\t]/.test(value)) return null;
  if (value === '~') return '~';
  if (value.startsWith('~/')) {
    const rest = value.slice(2).replace(/\/+$/, '');
    if (rest === '') return '~';
    return withValidSegments(rest) ? `~/${rest}` : null;
  }
  if (value.startsWith('/')) {
    // `/` alone is the filesystem root, not a workspace.
    const rest = value.replace(/\/+$/, '').slice(1);
    if (rest === '') return null;
    return withValidSegments(rest) ? `/${rest}` : null;
  }
  return null;
}

function withValidSegments(relative: string): boolean {
  const segments = relative.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** True when the value can be saved; callers store the normalised form. */
export function isValidWorkspacePath(raw: unknown): raw is string {
  return normalizeWorkspacePath(raw) !== null;
}
