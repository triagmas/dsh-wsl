/**
 * BrowserWindow factory and WebUI hardening.
 *
 * The backend window has no preload, no Node integration, no address bar and an
 * exact-origin navigation allowlist. The splash and settings windows are
 * app-owned local pages with tiny, explicit preload bridges.
 */
import { BrowserWindow, session, shell, type Session } from 'electron';
import { join } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ShellStatus } from '../../shared/types.js';
import { decideNavigation, decidePermission, decideWindowOpen } from '../core/navigation.js';
import type { WindowEventContext, WindowEventName, WindowSurface } from '../core/diagnostics.js';
import { splashWindowAttributes, type SplashPresentation } from '../core/visibility.js';

export const PARTITION = 'persist:wsl-web-shell';

export interface WindowsOptions {
  rendererDir: string;
  preloadDir: string;
  log: Logger;
  origin(): string;
  /** True only for development builds or an explicit developer-mode opt-in. */
  devToolsEnabled: boolean;
  onRendererGone(reason: string): void;
  onExternalLink(url: string): void;
  /** Window shown/hidden by the user (close to tray, tray open). */
  onVisibilityChanged(visible: boolean): void;
  /**
   * Visibility/close events of the app-owned windows, already reduced to
   * booleans and enumerated causes so they can be logged without page content.
   */
  onWindowEvent?(context: Omit<WindowEventContext, 'quitting' | 'sessionEnding'> & {
    surface: WindowSurface;
    event: WindowEventName;
  }): void;
}

export interface LoadBackendOptions {
  /** Reload even when the same origin is already loaded (after a restart). */
  force?: boolean;
}

export class Windows {
  private main: BrowserWindow | null = null;
  private splash: BrowserWindow | null = null;
  private settings: BrowserWindow | null = null;
  private status: ShellStatus | null = null;
  /** True once the app is definitively quitting; close then really closes. */
  private quitting = false;

  constructor(private readonly options: WindowsOptions) {}

  /** Create (once) the sandboxed backend window. */
  ensureMain(): BrowserWindow {
    if (this.main !== null && !this.main.isDestroyed()) return this.main;
    const window = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 720,
      minHeight: 520,
      show: false,
      title: 'DeepSeek Harness',
      backgroundColor: '#0b0f16',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        spellcheck: true,
        // Packaged builds keep the debugger closed unless development is explicit.
        devTools: this.options.devToolsEnabled,
      },
    });
    window.setMenuBarVisibility(false);

    window.webContents.on('will-navigate', (event, url) => {
      const decision = decideNavigation({
        url,
        origin: this.options.origin(),
        isMainFrame: true,
        isUserInitiated: false,
      });
      if (decision.action === 'allow') return;
      event.preventDefault();
      this.options.log.warn(`navigation blocked (${decision.action})`);
    });

    window.webContents.on('will-redirect', (event, url) => {
      const decision = decideNavigation({
        url,
        origin: this.options.origin(),
        isMainFrame: true,
        isUserInitiated: false,
      });
      if (decision.action === 'allow') return;
      event.preventDefault();
      this.options.log.warn('redirect blocked');
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, this.options.origin());
      if (decision.action === 'external') this.options.onExternalLink(decision.url);
      return { action: 'deny' };
    });

    window.webContents.on('will-attach-webview', (event) => {
      event.preventDefault();
      this.options.log.warn('webview attachment blocked');
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.log.error(`renderer gone: ${details.reason}`);
      this.options.onRendererGone(details.reason);
    });

    window.on('close', (event) => {
      this.reportWindowEvent('main', 'close-requested', window);
      // Close always hides to tray; only the explicit Quit path destroys it.
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    // Windows only: logoff/shutdown is announced before windows are closed, so
    // an OS-initiated close can be told apart from a user click on X.
    window.on('session-end', () => this.reportWindowEvent('main', 'session-end', window));
    window.on('show', () => {
      this.reportWindowEvent('main', 'shown', window);
      this.options.onVisibilityChanged(true);
    });
    window.on('hide', () => {
      this.reportWindowEvent('main', 'hidden', window);
      this.options.onVisibilityChanged(false);
    });
    window.on('minimize', () => {
      // Minimised is not "hidden in tray": supervision state must not change.
      this.options.log.debug('window minimized');
    });
    window.on('closed', () => {
      this.reportWindowEvent('main', 'closed', window);
      this.main = null;
    });
    this.main = window;
    return window;
  }

  get mainWindow(): BrowserWindow | null {
    return this.main !== null && !this.main.isDestroyed() ? this.main : null;
  }

  get settingsWindow(): BrowserWindow | null {
    return this.settings !== null && !this.settings.isDestroyed() ? this.settings : null;
  }

  setQuitting(): void {
    this.quitting = true;
  }

  private backendSession: Session | null = null;

  /**
   * Harden the shared session: deny permissions outside the allowlist.
   * Must be called after `app.whenReady()`; repeated calls return the same
   * configured session.
   */
  configureSession(): Session {
    if (this.backendSession !== null) return this.backendSession;
    const backendSession = session.fromPartition(PARTITION);
    backendSession.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(decidePermission(permission));
    });
    backendSession.setPermissionCheckHandler((_webContents, permission) => decidePermission(permission));
    backendSession.on('will-download', (event) => {
      // Downloads from backend content are not part of the product.
      event.preventDefault();
      this.options.log.warn('download blocked');
    });
    this.backendSession = backendSession;
    return backendSession;
  }

  showMain(): void {
    const window = this.ensureMain();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  hideMain(): void {
    this.mainWindow?.hide();
  }

  isMainVisible(): boolean {
    const window = this.mainWindow;
    return window !== null && window.isVisible();
  }

  /**
   * Splash doubles as the reconnect overlay while the backend recovers.
   *
   * `user` means the user asked for the app in this action: the surface is shown
   * and focused. `overlay` draws inside our own visible window and is shown with
   * `showInactive()`, so a reconnect never steals focus. `hidden` creates nothing
   * and hides a leftover overlay: a background start or a tray-mode reconnect must
   * not put a window over the desktop.
   */
  showSplash(presentation: SplashPresentation): void {
    if (presentation === 'hidden') {
      this.hideSplash();
      return;
    }
    if (this.splash !== null && !this.splash.isDestroyed()) {
      if (presentation === 'user') {
        this.splash.show();
        this.splash.focus();
      } else {
        this.splash.showInactive();
      }
      if (this.status !== null) this.publishStatus(this.status);
      return;
    }
    const attributes = splashWindowAttributes();
    const window = new BrowserWindow({
      width: 440,
      height: 320,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: attributes.alwaysOnTop,
      skipTaskbar: attributes.skipTaskbar,
      show: false,
      backgroundColor: '#0b0f16',
      title: 'WSL Web Shell',
      webPreferences: {
        preload: join(this.options.preloadDir, 'splash.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: this.options.devToolsEnabled,
      },
    });
    window.loadFile(join(this.options.rendererDir, 'splash', 'index.html')).catch((error: unknown) => {
      this.options.log.error(`splash load failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    window.once('ready-to-show', () => {
      if (presentation === 'user') window.show();
      else window.showInactive();
      if (this.status !== null) this.publishStatus(this.status);
    });
    window.on('show', () => this.reportWindowEvent('splash', 'shown', window));
    window.on('hide', () => this.reportWindowEvent('splash', 'hidden', window));
    window.on('close', () => this.reportWindowEvent('splash', 'close-requested', window));
    window.on('closed', () => {
      this.reportWindowEvent('splash', 'closed', window);
      this.splash = null;
    });
    this.splash = window;
  }

  /** Diagnostics only: never throws, never carries window content. */
  private reportWindowEvent(
    surface: WindowSurface,
    event: WindowEventName,
    window: BrowserWindow,
  ): void {
    const report = this.options.onWindowEvent;
    if (report === undefined) return;
    try {
      if (window.isDestroyed()) return;
      report({ surface, event, visible: window.isVisible(), focused: window.isFocused() });
    } catch {
      // Diagnostics must never affect window behaviour.
    }
  }

  /** Hide the overlay without destroying it (window sent to tray). */
  hideSplash(): void {
    if (this.splash !== null && !this.splash.isDestroyed()) this.splash.hide();
  }

  closeSplash(): void {
    if (this.splash !== null && !this.splash.isDestroyed()) this.splash.destroy();
    this.splash = null;
  }

  openSettings(): void {
    const existing = this.settingsWindow;
    if (existing !== null) {
      existing.show();
      existing.focus();
      return;
    }
    const parent = this.mainWindow;
    const window = new BrowserWindow({
      width: 620,
      height: 700,
      resizable: false,
      minimizable: true,
      maximizable: false,
      fullscreenable: false,
      title: 'WSL Web Shell — Settings',
      backgroundColor: '#0b0f16',
      parent: parent ?? undefined,
      webPreferences: {
        preload: join(this.options.preloadDir, 'settings.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: this.options.devToolsEnabled,
      },
    });
    window.setMenuBarVisibility(false);
    window.loadFile(join(this.options.rendererDir, 'settings', 'index.html')).catch((error: unknown) => {
      this.options.log.error(`settings load failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      this.settings = null;
    });
    this.settings = window;
  }

  publishStatus(status: ShellStatus): void {
    this.status = status;
    for (const window of [this.splash, this.settings]) {
      if (window === null || window.isDestroyed()) continue;
      window.webContents.send('shell:status', status);
    }
  }

  private loadInFlight: Promise<void> | null = null;

  /**
   * Load (or reload) the original WebUI.
   *
   * After a backend restart the same URL may still be "loaded" while the session
   * behind it is gone, so recovery passes `force`. Concurrent requests share one
   * navigation instead of racing, and the page is never replaced by a local
   * substitute UI.
   */
  async loadBackend(origin: string, options: LoadBackendOptions = {}): Promise<void> {
    const window = this.ensureMain();
    const target = `${origin}/`;
    const current = window.webContents.getURL();
    const alreadyThere = current === target || current === origin;
    if (alreadyThere && options.force !== true) return;
    if (this.loadInFlight !== null) {
      // Never race two navigations; a forced reload still happens afterwards,
      // because the in-flight document may predate the backend restart.
      await this.loadInFlight;
      if (options.force !== true) return;
    }
    const navigation = window
      .loadURL(target)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.options.log.error(`WebUI load failed: ${error instanceof Error ? error.name : 'unknown'}`);
      });
    this.loadInFlight = navigation;
    try {
      await navigation;
    } finally {
      if (this.loadInFlight === navigation) this.loadInFlight = null;
    }
  }

  openExternal(url: string): void {
    if (!/^https:\/\//i.test(url)) return;
    void shell.openExternal(url).catch(() => {
      this.options.log.warn('external browser hand-off failed');
    });
  }

  closeSettingsWindow(): void {
    this.settingsWindow?.close();
  }

  destroyAll(): void {
    this.setQuitting();
    for (const window of [this.settings, this.splash, this.main]) {
      if (window !== null && !window.isDestroyed()) window.destroy();
    }
    this.settings = null;
    this.splash = null;
    this.main = null;
  }
}
