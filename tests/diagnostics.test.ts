/**
 * Release Candidate diagnostics suite: window-event classification, previous
 * session classification, and the guarantee that neither a launch token nor a
 * local user path can reach the log through a close/termination diagnostic.
 */
import { describe, expect, it } from 'vitest';
import {
  CLEAN_SHUTDOWN_MARKER,
  PREVIOUS_SESSION_WINDOW,
  describeChildProcessGone,
  describeError,
  describeWindowEvent,
  redactUserPaths,
  summarizePreviousSession,
} from '../src/main/core/diagnostics.js';
import { containsSecret } from '../src/main/backend/urls.js';

const TOKEN = 'tok_0123456789abcdef0123456789abcdef';
const line = (message: string, level = 'INFO'): string =>
  `2026-01-01T00:00:00.000Z ${level} ${message}`;

describe('describeWindowEvent', () => {
  it('records the surface, the cause and the flags that identify an external close', () => {
    const text = describeWindowEvent({
      surface: 'main',
      event: 'close-requested',
      visible: true,
      focused: true,
      quitting: false,
      sessionEnding: false,
    });
    expect(text).toBe('window main close-requested (visible=yes focused=yes quitting=no session-ending=no)');
  });

  it('marks an OS-initiated close and an app-initiated close differently', () => {
    const os = describeWindowEvent({
      surface: 'main',
      event: 'close-requested',
      visible: true,
      focused: false,
      quitting: false,
      sessionEnding: true,
    });
    const app = describeWindowEvent({
      surface: 'main',
      event: 'hidden',
      visible: false,
      focused: false,
      quitting: true,
      sessionEnding: false,
    });
    expect(os).toContain('session-ending=yes');
    expect(os).toContain('quitting=no');
    expect(app).toContain('quitting=yes');
    expect(app).toContain('session-ending=no');
  });

  it('distinguishes the splash overlay from the main window', () => {
    const text = describeWindowEvent({
      surface: 'splash',
      event: 'hidden',
      visible: false,
      focused: false,
      quitting: false,
      sessionEnding: false,
    });
    expect(text.startsWith('window splash hidden')).toBe(true);
  });
});

describe('summarizePreviousSession', () => {
  it('treats a missing log as a clean start', () => {
    expect(summarizePreviousSession([])).toEqual({ clean: true, lastEvent: '' });
    expect(summarizePreviousSession(['', '   '])).toEqual({ clean: true, lastEvent: '' });
  });

  it('recognises an orderly quit through the shutdown marker', () => {
    const summary = summarizePreviousSession([
      line('backend ready'),
      line('quit requested'),
      line(`stopping owned backend pid=123`),
      line(CLEAN_SHUTDOWN_MARKER),
      line('app quit (exit code=0)'),
    ]);
    expect(summary.clean).toBe(true);
    expect(summary.lastEvent).toBe('app quit (exit code=0)');
  });

  it('reports an unclean end when the last run stopped mid-work', () => {
    const summary = summarizePreviousSession([
      line('starting backend (port=3080)'),
      line('startup token exchange status=200'),
      line('backend ready'),
    ]);
    expect(summary.clean).toBe(false);
    expect(summary.lastEvent).toBe('backend ready');
  });

  it('does not count a marker that is older than the inspected window', () => {
    const lines = [
      line(CLEAN_SHUTDOWN_MARKER),
      ...Array.from({ length: PREVIOUS_SESSION_WINDOW }, (_value, index) => line(`noise ${index}`)),
    ];
    expect(summarizePreviousSession(lines).clean).toBe(false);
  });

  it('keeps the last event safe for the log', () => {
    const summary = summarizePreviousSession([
      line(`loading failed for http://127.0.0.1:3080/?token=${TOKEN}`),
    ]);
    expect(summary.lastEvent).not.toContain(TOKEN);
    expect(containsSecret(summary.lastEvent)).toBe(false);
    expect(summary.lastEvent).toContain('[redacted]');
  });

  it('caps the reported event length', () => {
    const summary = summarizePreviousSession([line('x'.repeat(500))]);
    expect(summary.lastEvent.length).toBeLessThanOrEqual(160);
  });
});

describe('redactUserPaths', () => {
  it('masks windows and posix home directories', () => {
    expect(redactUserPaths('C:\\Users\\alice\\AppData\\Roaming\\wsl-web-shell\\config.json')).toBe(
      'C:\\Users\\<user>\\AppData\\Roaming\\wsl-web-shell\\config.json',
    );
    expect(redactUserPaths('/home/alice/.local/share/wsl-web-shell')).toBe(
      '/home/<user>/.local/share/wsl-web-shell',
    );
    expect(redactUserPaths('/mnt/c/Users/alice/AppData')).toBe('/mnt/<drive>/Users/<user>/AppData');
    expect(redactUserPaths('/Users/alice/Library/Logs')).toBe('/Users/<user>/Library/Logs');
  });

  it('leaves repository and application paths readable', () => {
    expect(redactUserPaths('/mnt/f/_hermes/CODE/wsl-web-shell/src/main/index.ts')).toBe(
      '/mnt/f/_hermes/CODE/wsl-web-shell/src/main/index.ts',
    );
  });
});

describe('describeError', () => {
  it('keeps the error name and message without a stack', () => {
    const error = new Error('backend start failed');
    const text = describeError(error);
    expect(text).toBe('Error: backend start failed');
    expect(text).not.toContain('at ');
  });

  it('never carries a launch token', () => {
    const text = describeError(new Error(`request failed for http://127.0.0.1:3080/?token=${TOKEN}`));
    expect(text).not.toContain(TOKEN);
    expect(containsSecret(text)).toBe(false);
  });

  it('masks user directories inside messages', () => {
    const text = describeError(new Error('cannot write /home/alice/.local/share/x/y'));
    expect(text).toBe('Error: cannot write /home/<user>/.local/share/x/y');
  });

  it('survives non-Error values and unserialisable payloads', () => {
    expect(describeError('plain failure')).toBe('Error: plain failure');
    expect(describeError(42)).toBe('Error: 42');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(describeError(circular)).toBe('Error: unserialisable error');
  });

  it('caps the message length', () => {
    expect(describeError(new Error('y'.repeat(900))).length).toBeLessThanOrEqual(300);
  });
});

describe('describeChildProcessGone', () => {
  it('classifies a renderer crash without payload', () => {
    const text = describeChildProcessGone({ type: 'Renderer', reason: 'crashed', exitCode: 5 });
    expect(text).toBe('child process gone (type=Renderer reason=crashed exit=5)');
  });

  it('tolerates missing fields and adds a service name', () => {
    expect(describeChildProcessGone({})).toBe('child process gone (type=unknown reason=unknown exit=n/a)');
    expect(describeChildProcessGone({ type: 'Utility', serviceName: 'network.mojom.NetworkService' })).toContain(
      'service=network.mojom.NetworkService',
    );
  });
});
