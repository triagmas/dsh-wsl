/**
 * Display-safe text for every user-visible surface.
 *
 * Diagnostics may carry captured backend output, exception text or a URL that
 * once contained a launch token. Everything that leaves the supervisor — status
 * detail, error hint, tray/dialog text — passes through here, not only the log.
 */
import { redactSecrets } from '../backend/urls.js';

export const MAX_DISPLAY_LENGTH = 600;

/**
 * Strip terminal escapes and control characters, collapse whitespace, redact
 * secrets and cap the length. Newlines survive as line breaks so multi-line
 * hints stay readable.
 */
export function sanitizeForDisplay(text: string, maxLength = MAX_DISPLAY_LENGTH): string {
  const withoutAnsi = text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
  const withoutControl = withoutAnsi.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  const normalized = withoutControl
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim();
  const redacted = redactSecrets(normalized);
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1)}…` : redacted;
}

/** `null` stays `null` so the UI can distinguish "no detail" from "empty". */
export function sanitizeOptional(text: string | null): string | null {
  if (text === null) return null;
  const safe = sanitizeForDisplay(text);
  return safe === '' ? null : safe;
}
