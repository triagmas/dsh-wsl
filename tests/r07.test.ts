/**
 * Issue #7 regression suite: the loading surface must not be intrusive.
 *
 * Covers the pure policy (launch mode, start-up surface, splash presentation,
 * window attributes) and guards the Electron wiring against reintroducing an
 * always-on-top window or a focus grab from a tray-mode reconnect.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decideLaunchMode,
  decideReadyVisibility,
  decideSplashPresentation,
  decideStartupSurface,
  splashWindowAttributes,
} from '../src/main/core/visibility.js';

const repoRoot = join(import.meta.dirname, '..');
const windowsSource = readFileSync(join(repoRoot, 'src/main/electron/windows.ts'), 'utf8');
const indexSource = readFileSync(join(repoRoot, 'src/main/index.ts'), 'utf8');

describe('launch mode', () => {
  it('defaults to an interactive launch', () => {
    expect(decideLaunchMode({ flag: false, env: false })).toBe('interactive');
  });

  it('accepts the automation flag and the environment variable', () => {
    expect(decideLaunchMode({ flag: true, env: false })).toBe('automation');
    expect(decideLaunchMode({ flag: false, env: true })).toBe('automation');
    expect(decideLaunchMode({ flag: true, env: true })).toBe('automation');
  });
});

describe('start-up loading surface', () => {
  it('is shown when the user started the app to see it', () => {
    expect(decideStartupSurface({ mode: 'interactive', openOnLaunch: true })).toBe('splash');
  });

  it('is suppressed for a background start', () => {
    expect(decideStartupSurface({ mode: 'interactive', openOnLaunch: false })).toBe('none');
  });

  it('is suppressed in automation mode regardless of settings', () => {
    expect(decideStartupSurface({ mode: 'automation', openOnLaunch: true })).toBe('none');
    expect(decideStartupSurface({ mode: 'automation', openOnLaunch: false })).toBe('none');
  });
});

describe('splash presentation', () => {
  const base = { reason: 'blocked' as const, mode: 'interactive' as const };

  it('focuses only when the user performed the action', () => {
    expect(
      decideSplashPresentation({ ...base, userRequested: true, mainVisible: false }),
    ).toBe('user');
    expect(
      decideSplashPresentation({ ...base, reason: 'startup', userRequested: true, mainVisible: false }),
    ).toBe('user');
  });

  it('draws a tray-mode reconnect inside the visible window without focus', () => {
    expect(decideSplashPresentation({ ...base, userRequested: false, mainVisible: true })).toBe('overlay');
  });

  it('shows nothing when the app is hidden in the tray', () => {
    expect(decideSplashPresentation({ ...base, userRequested: false, mainVisible: false })).toBe(
      'hidden',
    );
    expect(
      decideSplashPresentation({ ...base, reason: 'startup', userRequested: false, mainVisible: false }),
    ).toBe('hidden');
  });

  it('never presents anything in automation mode', () => {
    for (const userRequested of [true, false]) {
      for (const mainVisible of [true, false]) {
        expect(
          decideSplashPresentation({
            reason: 'blocked',
            mode: 'automation',
            userRequested,
            mainVisible,
          }),
        ).toBe('hidden');
      }
    }
  });
});

describe('ready visibility with launch mode', () => {
  it('never opens a window in automation mode', () => {
    expect(
      decideReadyVisibility({ openOnLaunch: true, everShown: false, visible: false, mode: 'automation' }),
    ).toBe('keep-hidden');
  });

  it('keeps the interactive behaviour unchanged', () => {
    expect(
      decideReadyVisibility({ openOnLaunch: true, everShown: false, visible: false, mode: 'interactive' }),
    ).toBe('show');
    expect(
      decideReadyVisibility({ openOnLaunch: true, everShown: true, visible: false, mode: 'interactive' }),
    ).toBe('keep-hidden');
  });
});

describe('splash window attributes', () => {
  it('is never always-on-top and stays out of the taskbar', () => {
    expect(splashWindowAttributes()).toEqual({ alwaysOnTop: false, skipTaskbar: true, focusable: true });
  });
});

describe('Electron wiring guards', () => {
  it('does not create an always-on-top splash window', () => {
    expect(windowsSource).not.toMatch(/alwaysOnTop:\s*true/);
    expect(windowsSource).toContain('alwaysOnTop: attributes.alwaysOnTop');
  });

  it('shows a reconnect overlay without stealing focus', () => {
    expect(windowsSource).toContain("presentation === 'user'");
    expect(windowsSource).toContain('this.splash.showInactive()');
    expect(windowsSource).toContain('window.showInactive()');
  });

  it('creates no splash window at all when the policy says hidden', () => {
    expect(windowsSource).toMatch(/if \(presentation === 'hidden'\) \{\s*this\.hideSplash\(\);\s*return;/);
  });

  it('never calls the old focus-grabbing splash API', () => {
    expect(indexSource).not.toContain('showSplash({ activate');
  });

  it('suppresses every window-opening path in automation mode', () => {
    const guards = indexSource.match(/launchMode === 'automation'/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(4);
    expect(indexSource).toContain("WSL_WEB_SHELL_AUTOMATION === '1'");
    expect(indexSource).toContain("argument === '--automation' || argument === '--quiet'");
  });

  it('routes start-up and reconnect through the single presentation helper', () => {
    expect(indexSource).toContain('const presentSplash = (reason:');
    expect(indexSource).toContain("presentSplash('blocked', false)");
    expect(indexSource).toContain("presentSplash('startup', true)");
  });
});
