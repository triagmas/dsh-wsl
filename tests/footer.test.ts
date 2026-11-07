/**
 * Issue #9 footer model: state colour/label mapping, version labels, geometry of
 * the WebUI view above the bar, popover placement and anchor validation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FOOTER_HEIGHT,
  computePopoverBounds,
  computeViewBounds,
  describeConnection,
  describeInstalledLabel,
  describeLatestLabel,
  parsePopoverAnchor,
} from '../src/main/core/footer.js';
import { compareSemver } from '../src/main/core/versions.js';
import type { LifecycleState } from '../src/shared/types.js';

const repoRoot = join(import.meta.dirname, '..');
const chromeCss = readFileSync(join(repoRoot, 'src/chrome/chrome.css'), 'utf8');

describe('footer bar height', () => {
  it('stays inside the requested 30-34 px range', () => {
    expect(FOOTER_HEIGHT).toBeGreaterThanOrEqual(30);
    expect(FOOTER_HEIGHT).toBeLessThanOrEqual(34);
  });

  it('matches the CSS variable used by the footer page', () => {
    const match = /--footer-height:\s*(\d+)px/.exec(chromeCss);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBe(FOOTER_HEIGHT);
  });
});

describe('connection mapping', () => {
  const states: LifecycleState[] = [
    'CHECKING',
    'STARTING_WSL',
    'STARTING_WEB',
    'CONNECTING',
    'READY',
    'HIDDEN_IN_TRAY',
    'RECOVERING',
    'ERROR',
    'QUITTING',
  ];

  it('colours healthy, transitional, failed and idle states distinctly', () => {
    const tones = Object.fromEntries(
      states.map((state) => [state, describeConnection({ state, distro: 'Ubuntu', port: 3080 }).tone]),
    );
    expect(tones.READY).toBe('ok');
    expect(tones.HIDDEN_IN_TRAY).toBe('ok');
    expect(tones.CHECKING).toBe('warn');
    expect(tones.STARTING_WSL).toBe('warn');
    expect(tones.STARTING_WEB).toBe('warn');
    expect(tones.CONNECTING).toBe('warn');
    expect(tones.RECOVERING).toBe('warn');
    expect(tones.ERROR).toBe('error');
    expect(tones.QUITTING).toBe('idle');
  });

  it('always provides a text label, never colour alone', () => {
    for (const state of states) {
      const view = describeConnection({ state, distro: 'Ubuntu', port: 3080 });
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.description).toContain(view.label);
    }
  });

  it('uses the real distro and port from the status snapshot', () => {
    const view = describeConnection({ state: 'READY', distro: 'Debian-Test', port: 4242 });
    expect(view.endpoint).toBe('WSL Debian-Test :4242');
    expect(view.description).toBe('Connected — WSL Debian-Test :4242');
  });
});

describe('version labels', () => {
  const latest = {
    version: '0.2.2-rc.1',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
    prerelease: true,
    publishedAt: '2026-11-04T00:00:00Z',
  };

  it('shows an em dash when the installed version is unknown', () => {
    expect(describeInstalledLabel(null)).toBe('DSH —');
    expect(describeInstalledLabel('')).toBe('DSH —');
    expect(describeInstalledLabel('0.2.1-rc.5')).toBe('DSH 0.2.1-rc.5');
  });

  it('shows a pending label instead of claiming "up to date"', () => {
    const label = describeLatestLabel(null, '0.2.1-rc.5', compareSemver);
    expect(label.text).toBe('GitHub …');
    expect(label.pending).toBe(true);
    expect(label.updateAvailable).toBe(false);
  });

  it('marks a newer upstream release and keeps equal versions quiet', () => {
    expect(describeLatestLabel(latest, '0.2.1-rc.5', compareSemver)).toEqual({
      text: 'GitHub 0.2.2-rc.1',
      updateAvailable: true,
      pending: false,
    });
    const equal = describeLatestLabel({ ...latest, version: '0.2.1-rc.5' }, '0.2.1-rc.5', compareSemver);
    expect(equal.updateAvailable).toBe(false);
    const older = describeLatestLabel({ ...latest, version: '0.2.0' }, '0.2.1-rc.5', compareSemver);
    expect(older.updateAvailable).toBe(false);
  });

  it('does not claim an update when the installed version is unknown', () => {
    expect(describeLatestLabel(latest, null, compareSemver).updateAvailable).toBe(false);
  });
});

describe('view geometry', () => {
  it('leaves exactly the bar height for the remote WebUI', () => {
    expect(computeViewBounds(1280, 860)).toEqual({ x: 0, y: 0, width: 1280, height: 860 - FOOTER_HEIGHT });
  });

  it('never returns negative bounds for a tiny window', () => {
    expect(computeViewBounds(720, 20)).toEqual({ x: 0, y: 0, width: 720, height: 0 });
    expect(computeViewBounds(0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('floors fractional sizes from scaled displays', () => {
    expect(computeViewBounds(1024.6, 700.4)).toEqual({ x: 0, y: 0, width: 1024, height: 700 - FOOTER_HEIGHT });
  });
});

describe('popover placement', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
  const size = { width: 360, height: 560 };

  it('sits above the gear and stays inside the work area', () => {
    const bounds = computePopoverBounds({
      anchor: { x: 1240, y: 824, width: 24, height: 22 },
      window: { x: 0, y: 0 },
      size,
      workArea,
    });
    expect(bounds.width).toBe(360);
    expect(bounds.height).toBe(560);
    expect(bounds.x).toBe(1264 - 360);
    expect(bounds.y).toBe(824 - 560 - 6);
  });

  it('is clamped to the display edges', () => {
    const right = computePopoverBounds({
      anchor: { x: 10, y: 30, width: 24, height: 22 },
      window: { x: 100, y: 100 },
      size,
      workArea,
    });
    expect(right.x).toBeGreaterThanOrEqual(workArea.x);
    const left = computePopoverBounds({
      anchor: { x: 1400, y: 30, width: 24, height: 22 },
      window: { x: 900, y: 100 },
      size,
      workArea,
    });
    expect(left.x + left.width).toBeLessThanOrEqual(workArea.x + workArea.width);
  });

  it('falls back to the bottom of the work area when there is no room above', () => {
    const bounds = computePopoverBounds({
      anchor: { x: 100, y: 5, width: 24, height: 22 },
      window: { x: 0, y: 0 },
      size,
      workArea,
    });
    expect(bounds.y).toBe(workArea.y + workArea.height - 560);
  });
});

describe('anchor validation', () => {
  it('rejects payloads that are not four finite numbers', () => {
    expect(parsePopoverAnchor(null)).toBeNull();
    expect(parsePopoverAnchor('12,34')).toBeNull();
    expect(parsePopoverAnchor({ x: 1, y: 2, width: 3 })).toBeNull();
    expect(parsePopoverAnchor({ x: 1, y: 2, width: 3, height: Number.POSITIVE_INFINITY })).toBeNull();
    expect(parsePopoverAnchor({ x: 1, y: 2, width: 3, height: 1_000_000 })).toBeNull();
  });

  it('accepts a normal gear rect', () => {
    expect(parsePopoverAnchor({ x: 10, y: 20, width: 24, height: 22 })).toEqual({
      x: 10,
      y: 20,
      width: 24,
      height: 22,
    });
  });
});
