/**
 * Issue #9 composition guards.
 *
 * These are source-level invariants, not a runtime proof: they pin the pieces of
 * the new layout that must not silently regress — the remote WebUI stays in its
 * own `WebContentsView`, the bar is a local page, hardening follows the WebUI
 * contents, the splash and the agreed window behaviour are untouched, and every
 * new IPC channel validates its sender.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8');

/** Every TypeScript source under a directory, as workspace-relative POSIX paths. */
const sourceFiles = (directory: string): string[] => {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...sourceFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(child);
  }
  return found;
};

const windowsSource = read('src/main/electron/windows.ts');
const indexSource = read('src/main/index.ts');
const chromeHtml = read('src/chrome/index.html');
const chromeCss = read('src/chrome/chrome.css');
const preloadChrome = read('src/preload/chrome.ts');
const preloadPopover = read('src/preload/popover.ts');
const buildScript = read('scripts/build.mjs');

describe('WebUI isolation', () => {
  it('hosts the remote WebUI in a WebContentsView, not in the window itself', () => {
    expect(windowsSource).toContain('new WebContentsView(');
    expect(windowsSource).toContain('contentView.addChildView(view)');
    expect(windowsSource).toContain('computeViewBounds(');
  });

  it('keeps the sandboxed, context-isolated backend partition', () => {
    const viewBlock = windowsSource.slice(
      windowsSource.indexOf('private ensureBackendView'),
      windowsSource.indexOf('private destroyBackendView'),
    );
    expect(viewBlock).toContain('partition: PARTITION');
    expect(viewBlock).toContain('contextIsolation: true');
    expect(viewBlock).toContain('sandbox: true');
    expect(viewBlock).toContain('nodeIntegration: false');
    expect(viewBlock).toContain("setWindowOpenHandler");
    expect(viewBlock).toContain("contents.on('will-navigate'");
    expect(viewBlock).toContain("contents.on('will-redirect'");
    expect(viewBlock).toContain('webviewTag');
  });

  it('never injects markup, CSS or JavaScript into the remote pages', () => {
    expect(windowsSource).not.toContain('insertCSS');
    expect(windowsSource).not.toContain('executeJavaScript');
    expect(windowsSource).not.toContain('insertText');
  });

  it('navigates the view, not the window contents', () => {
    const loadBlock = windowsSource.slice(windowsSource.indexOf('async loadBackend('));
    expect(loadBlock).toContain('view.webContents');
  });
});

describe('footer page', () => {
  it('is a local page with a strict CSP and no remote resources', () => {
    expect(chromeHtml).toContain("default-src 'none'");
    expect(chromeHtml).not.toMatch(/https?:\/\//);
    expect(chromeHtml).toContain('src="./chrome.js"');
  });

  it('shows connection, distro/port, both versions and the gear', () => {
    for (const id of ['dot', 'conn-label', 'endpoint', 'installed', 'latest', 'gear']) {
      expect(chromeHtml).toContain(`id="${id}"`);
    }
    expect(chromeHtml).toContain('aria-expanded="false"');
  });

  it('keeps the bar height in the requested range and honours reduced motion', () => {
    expect(chromeCss).toMatch(/--footer-height:\s*32px/);
    expect(chromeCss).toContain('prefers-reduced-motion');
  });

  it('never offers an update action', () => {
    for (const source of [chromeHtml, read('src/chrome/chrome.js')]) {
      expect(source.toLowerCase()).not.toContain('auto-update');
      expect(source.toLowerCase()).not.toContain('install update');
    }
  });
});

describe('preload bridges', () => {
  it('expose only named channels and never the raw ipcRenderer', () => {
    for (const preload of [preloadChrome, preloadPopover]) {
      expect(preload).toContain('contextBridge.exposeInMainWorld');
      // Every subscription must be a literal channel name.
      for (const match of preload.matchAll(/ipcRenderer\.(?:on|invoke|send)\(\s*([^,)]*)/g)) {
        const channel = (match[1] ?? '').trim();
        expect(channel.startsWith("'") || channel.startsWith('"')).toBe(true);
      }
      expect(preload).not.toMatch(/exposeInMainWorld\([^,]+,\s*\{\s*ipcRenderer/);
    }
    expect(preloadChrome).toMatch(/'footer:(status|versions|toggle-settings|open-release)'/);
    expect(preloadChrome).not.toMatch(/settings:save/);
    expect(preloadPopover).not.toMatch(/footer:open-release/);
  });

  it('reuse the existing settings channels so validation stays in one place', () => {
    for (const channel of ['settings:load', 'settings:save', 'settings:distros', 'settings:open-window']) {
      expect(preloadPopover).toContain(channel);
    }
    expect(preloadPopover).toContain('popover:close');
  });
});

describe('main process wiring', () => {
  const guarded = (channel: string): boolean =>
    new RegExp(`guard\\('${channel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(indexSource);

  it('registers every new channel through the trusted-sender guard', () => {
    for (const channel of [
      'footer:status',
      'footer:versions',
      'footer:toggle-settings',
      'footer:open-release',
      'popover:close',
      'settings:open-window',
    ]) {
      expect(guarded(channel)).toBe(true);
    }
  });

  it('validates the popover anchor before using it as geometry', () => {
    expect(indexSource).toContain('parsePopoverAnchor(anchor)');
    expect(indexSource).toContain("throw new Error('invalid-anchor')");
  });

  it('opens only the URL that came from the upstream lookup', () => {
    const block = indexSource.slice(indexSource.indexOf("guard('footer:open-release'"));
    expect(block).toContain('versions.snapshot().latest?.url');
    expect(block).toContain('windows.openExternal');
  });

  it('pushes status to every window that renders it, including the popover', () => {
    const block = windowsSource.slice(
      windowsSource.indexOf('publishStatus(status: ShellStatus)'),
      windowsSource.indexOf('publishVersions'),
    );
    for (const surface of ['this.main', 'this.splash', 'this.settings', 'this.popover']) {
      expect(block).toContain(surface);
    }
    // The popover renders `shell:status` through its preload, so a status that is
    // published while it is open must reach it.
    expect(preloadPopover).toContain("'shell:status'");
  });

  it('re-asserts the remote surface whenever the window becomes visible (issue #11)', () => {
    // Geometry and stacking can both look right while the view keeps an empty
    // compositor surface, so every "visible again" path must re-apply them.
    expect(windowsSource).toContain('private syncBackendView(');
    expect(windowsSource).toContain("window.on('show'");
    expect(windowsSource).toContain("window.on('ready-to-show'");
    expect(windowsSource).toContain("window.webContents.on('did-finish-load'");
    expect(windowsSource).toContain("screen.on('display-metrics-changed'");
    const showBlock = windowsSource.slice(
      windowsSource.indexOf("window.on('show'"),
      windowsSource.indexOf("window.on('hide'"),
    );
    expect(showBlock).toContain('this.syncBackendView()');
    const syncBlock = windowsSource.slice(
      windowsSource.indexOf('private syncBackendView('),
      windowsSource.indexOf('private watchDisplays('),
    );
    expect(syncBlock).toContain('removeChildView');
    expect(syncBlock).toContain('addChildView');
    expect(syncBlock).toContain('this.layoutMain()');
  });

  it('reports the resolved WebUI geometry once per window (issue #11)', () => {
    expect(windowsSource).toContain('webui layout:');
    expect(windowsSource).toContain('this.layoutLogged = false');
  });

  it('keeps DSH installation inside the confirmed update path (issue #17)', () => {
    // The launcher never installs anything: npm runs only inside the fixed WSL
    // updater scripts, and only when the user confirmed the update. This guard
    // fails when a new module starts mentioning an install outside the path.
    const allowed = new Set([
      'src/main/wsl/update-args.ts', // the scripts that actually run npm
      'src/main/wsl/gateway.ts', // "install it the usual way" guidance
      'src/main/core/update.ts', // documents that the target becomes an npm operand
      'src/main/core/update-runner.ts', // documents the install step it drives
      'src/main/core/update-recovery.ts', // manual recovery instructions
    ]);
    const mentions = sourceFiles('src/main').filter((file) => /npm install/.test(read(file)));
    expect(mentions.length).toBeGreaterThan(0);
    for (const file of mentions) expect(allowed.has(file)).toBe(true);
    for (const source of [indexSource, windowsSource, read('src/main/backend/github-versions.ts')]) {
      expect(source).not.toMatch(/npm install/);
      expect(source).not.toMatch(/(?:execFile|spawn)\([^)]*['"]npm['"]/);
      expect(source).not.toMatch(/unlinkSync\('.*runtime/);
    }
  });

  it('quits gracefully instead of hiding when Windows ends the session', () => {
    // A logoff must not leave the window hiding to tray: the OS would force-kill
    // the process before the clean-shutdown marker and the backend stop happen.
    const closeBlock = windowsSource.slice(
      windowsSource.indexOf("window.on('close'"),
      windowsSource.indexOf("window.on('session-end'"),
    );
    expect(closeBlock).toContain('this.quitting || this.sessionEnding');
    const sessionBlock = windowsSource.slice(
      windowsSource.indexOf("window.on('session-end'"),
      windowsSource.indexOf("window.on('show'"),
    );
    expect(sessionBlock).toContain('this.options.onSessionEnd?.()');
    expect(indexSource).toContain('onSessionEnd:');
    expect(indexSource).toContain('system session end: quitting gracefully');
  });

  it('does not re-introduce the reverted Issue #7 automation mode', () => {
    for (const source of [indexSource, windowsSource, read('src/main/core/visibility.ts')]) {
      expect(source).not.toContain('WSL_WEB_SHELL_AUTOMATION');
      expect(source).not.toContain('showInactive');
    }
  });
});

describe('build pipeline', () => {
  it('emits the footer and popover pages and preloads', () => {
    for (const dir of ['splash', 'settings', 'chrome', 'popover']) {
      expect(buildScript).toContain(`'${dir}'`);
    }
    expect(buildScript).toContain("preload/chrome.js'");
    expect(buildScript).toContain("preload/popover.js'");
  });
});
