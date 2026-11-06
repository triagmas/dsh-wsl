/**
 * Safe diagnostics for window visibility and process lifetime.
 *
 * Two questions recur in a tray application and both are invisible from the UI:
 *  - why a window disappeared (user close, tray action, OS logoff, crash);
 *  - why a process ended (clean quit, fatal error, external kill, crash).
 *
 * This module only classifies causes and counts. It never reads window content,
 * page text, backend output or environment values, and every string that reaches
 * the log passes through `sanitizeForDisplay` (ANSI/control stripping plus token
 * redaction) with an extra pass that masks home directories. Tokens therefore
 * cannot leak through a close/termination diagnostic even when an exception text
 * happens to embed a tokenized URL or a user path.
 */
import { sanitizeForDisplay } from './display.js';

/** Written last on an orderly exit; its presence identifies a clean shutdown. */
export const CLEAN_SHUTDOWN_MARKER = 'shutdown complete';

/** How many trailing log lines are inspected when classifying a previous run. */
export const PREVIOUS_SESSION_WINDOW = 5;

export type WindowSurface = 'main' | 'splash';

export type WindowEventName = 'shown' | 'hidden' | 'close-requested' | 'closed' | 'session-end';

export interface WindowEventContext {
  surface: WindowSurface;
  event: WindowEventName;
  /** True while the window is visible right now. */
  visible: boolean;
  focused: boolean;
  /** True once the app is definitively quitting. */
  quitting: boolean;
  /** True after Windows announced logoff/shutdown. */
  sessionEnding: boolean;
}

/**
 * One log line per window event.
 *
 * `close-requested` without `sessionEnding` and without `quitting` means the
 * close came from outside the app (X button, Alt+F4, taskbar menu, a page call
 * to `window.close()`); the app itself only ever quits through `quitting=true`.
 */
export function describeWindowEvent(context: WindowEventContext): string {
  const flags = [
    `visible=${context.visible ? 'yes' : 'no'}`,
    `focused=${context.focused ? 'yes' : 'no'}`,
    `quitting=${context.quitting ? 'yes' : 'no'}`,
    `session-ending=${context.sessionEnding ? 'yes' : 'no'}`,
  ];
  return `window ${context.surface} ${context.event} (${flags.join(' ')})`;
}

export interface PreviousSessionSummary {
  /** True when the previous run ended through the app's own quit path. */
  clean: boolean;
  /** Sanitized last log message of the previous run (may be empty). */
  lastEvent: string;
}

/** Split `"<iso> <LEVEL> <message>"` into the message part. */
function messageOf(line: string): string {
  const match = /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z\s+(?:INFO|WARN|ERROR|DEBUG)\s+(.*)$/.exec(line.trim());
  return match === null ? line.trim() : (match[1] ?? '');
}

/**
 * Classify the run that produced the tail of the log file.
 *
 * A previous run that was killed (Task Manager, `Stop-Process`, power loss) or
 * that died from a native fault leaves no shutdown marker, while an orderly quit
 * always writes one. The last event is reported so the next start can point at
 * the moment the previous process stopped writing.
 */
export function summarizePreviousSession(lines: string[]): PreviousSessionSummary {
  const usable = lines.map((line) => line.trim()).filter((line) => line !== '');
  if (usable.length === 0) return { clean: true, lastEvent: '' };
  const recent = usable.slice(-PREVIOUS_SESSION_WINDOW);
  const clean = recent.some((line) => messageOf(line).startsWith(CLEAN_SHUTDOWN_MARKER));
  const lastEvent = sanitizeForDisplay(messageOf(usable[usable.length - 1] as string), 160);
  return { clean, lastEvent };
}

/**
 * Mask home directories so a path from an exception or a log line cannot
 * identify the local account. Repository and application paths stay readable.
 */
export function redactUserPaths(text: string): string {
  return text
    .replace(/([A-Za-z]:[\\/]Users[\\/])[^\\/\s"']+/g, '$1<user>')
    .replace(/\/mnt\/[a-z]\/Users\/[^/\s"']+/g, '/mnt/<drive>/Users/<user>')
    .replace(/\/home\/[^/\s"']+/g, '/home/<user>')
    .replace(/\/Users\/[^/\s"']+/g, '/Users/<user>');
}

/** Message-only fatal/error description: no stack, no paths, no secrets. */
export function describeError(error: unknown, maxLength = 300): string {
  const name = error instanceof Error ? error.name : 'Error';
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return 'unserialisable error';
            }
          })();
  return sanitizeForDisplay(`${name}: ${redactUserPaths(String(raw))}`, maxLength);
}

export interface ChildProcessGoneDetails {
  type?: string;
  reason?: string;
  exitCode?: number;
  serviceName?: string;
  name?: string;
}

/** Describe an Electron child-process failure without any captured payload. */
export function describeChildProcessGone(details: ChildProcessGoneDetails): string {
  const parts = [
    `type=${details.type ?? 'unknown'}`,
    `reason=${details.reason ?? 'unknown'}`,
    `exit=${typeof details.exitCode === 'number' ? details.exitCode : 'n/a'}`,
  ];
  if (details.serviceName) parts.push(`service=${details.serviceName}`);
  if (details.name) parts.push(`name=${details.name}`);
  return sanitizeForDisplay(`child process gone (${parts.join(' ')})`, 200);
}
