/**
 * BrowserWindow factory and WebUI hardening.
 *
 * The backend window has no preload, no Node integration, no address bar and an
 * exact-origin navigation allowlist. The splash and settings windows are
 * app-owned local pages with tiny, explicit preload bridges.
 */
import { BrowserWindow, WebContentsView, screen, session, shell, type Session } from 'electron';
import { join } from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ShellStatus, VersionSnapshot } from '../../shared/types.js';
import { computePopoverBounds, computeViewBounds, type PopoverAnchor } from '../core/footer.js';
import { decideNavigation, decidePermission, decideWindowOpen } from '../core/navigation.js';
import type { WindowEventContext, WindowEventName, WindowSurface } from '../core/diagnostics.js';

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

export interface SplashOptions {
  /** Focus the overlay; false keeps it behind the desktop while hidden. */
  activate: boolean;
}

export interface LoadBackendOptions {
  /** Reload even when the same origin is already loaded (after a restart). */
  force?: boolean;
}

export class Windows {
  private main: BrowserWindow | null = null;
  /** Remote WebUI rendered above the app-owned footer bar. */
  private backendView: WebContentsView | null = null;
  private splash: BrowserWindow | null = null;
  private settings: BrowserWindow | null = null;
  private popover: BrowserWindow | null = null;
  private popoverClosedAt = 0;
  private status: ShellStatus | null = null;
  private versions: VersionSnapshot | null = null;
  /** True once the app is definitively quitting; close then really closes. */
  private quitting = false;

  constructor(private readonly options: WindowsOptions) {}

  /**
   * Create the main window once.
   *
   * The window itself is an app-owned chrome page (footer bar only); the remote
   * WebUI lives in a separate `WebContentsView` placed above the bar, so the
   * original page is never modified, wrapped or injected into.
   */
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
        preload: join(this.options.preloadDir, 'chrome.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        devTools: this.options.devToolsEnabled,
      },
    });
    window.setMenuBarVisibility(false);

    // The footer page is local and never navigates away or opens windows.
    window.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) return;
      event.preventDefault();
      this.options.log.warn('footer navigation blocked');
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, details) => {
      this.options.log.error(`footer renderer gone: ${details.reason}`);
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
      // A popover must never float once its window is gone.
      this.closeSettingsPopover();
    });
    window.on('minimize', () => {
      // Minimised is not "hidden in tray": supervision state must not change.
      this.options.log.debug('window minimized');
      this.closeSettingsPopover();
    });
    window.on('move', () => this.closeSettingsPopover());
    // Overloaded typings: register each geometry event explicitly.
    window.on('resize', () => this.layoutMain());
    window.on('maximize', () => this.layoutMain());
    window.on('unmaximize', () => this.layoutMain());
    window.on('restore', () => this.layoutMain());
    window.on('enter-full-screen', () => this.layoutMain());
    window.on('leave-full-screen', () => this.layoutMain());
    window.on('closed', () => {
      this.reportWindowEvent('main', 'closed', window);
      this.closeSettingsPopover();
      this.destroyBackendView();
      this.main = null;
    });
    this.main = window;
    this.loadFooter(window);
    this.ensureBackendView();
    this.layoutMain();
    return window;
  }

  private loadFooter(window: BrowserWindow): void {
    window.webContents.on('did-finish-load', () => {
      this.options.log.info('footer bar ready');
      this.replayFooterState();
    });
    window.loadFile(join(this.options.rendererDir, 'chrome', 'index.html')).catch((error: unknown) => {
      this.options.log.error(`footer load failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
  }

  /**
   * Remote WebUI surface with the same hardening the window carried before:
   * isolated partition, sandbox, no Node, exact-origin navigation, denied
   * popups/webviews/downloads and no DevTools in packaged builds.
   */
  private ensureBackendView(): WebContentsView {
    const existing = this.backendView;
    if (existing !== null && !existing.webContents.isDestroyed()) return existing;
    const view = new WebContentsView({
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
    const contents = view.webContents;

    contents.on('will-navigate', (event, url) => {
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

    contents.on('will-redirect', (event, url) => {
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

    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen(url, this.options.origin());
      if (decision.action === 'external') this.options.onExternalLink(decision.url);
      return { action: 'deny' };
    });

    contents.on('will-attach-webview', (event) => {
      event.preventDefault();
      this.options.log.warn('webview attachment blocked');
    });

    contents.on('render-process-gone', (_event, details) => {
      this.options.log.error(`renderer gone: ${details.reason}`);
      this.options.onRendererGone(details.reason);
    });

    this.backendView = view;
    this.options.log.info('webui surface created');
    this.mainWindow?.contentView.addChildView(view);
    return view;
  }

  private destroyBackendView(): void {
    const view = this.backendView;
    this.backendView = null;
    if (view === null) return;
    try {
      this.mainWindow?.contentView.removeChildView(view);
    } catch {
      // Window already gone: only the contents remain to be released.
    }
    if (!view.webContents.isDestroyed()) view.webContents.close();
  }

  /** Keep the WebUI above the footer on every geometry change. */
  private layoutMain(): void {
    const window = this.mainWindow;
    const view = this.backendView;
    if (window === null || view === null || view.webContents.isDestroyed()) return;
    const size = window.getContentSize();
    const bounds = computeViewBounds(size[0] ?? 0, size[1] ?? 0);
    if (bounds.width === 0 || bounds.height === 0) return;
    view.setBounds(bounds);
  }

  get settingsPopoverOpen(): boolean {
    return this.popover !== null && !this.popover.isDestroyed();
  }

  /**
   * Gear click: open the popover, or close it. A blur-close that happened a
   * moment ago is treated as the same click, so the gear toggles reliably even
   * though focusing the main window blurs the popover first.
   */
  toggleSettingsPopover(anchor: PopoverAnchor): void {
    if (this.popover !== null && !this.popover.isDestroyed()) {
      this.closeSettingsPopover();
      return;
    }
    if (Date.now() - this.popoverClosedAt < 350) return;
    this.openSettingsPopover(anchor);
  }

  openSettingsPopover(anchor: PopoverAnchor): void {
    const window = this.mainWindow;
    if (window === null || this.popover !== null) return;
    const contentBounds = window.getContentBounds();
    const workArea = screen.getDisplayMatching(contentBounds).workArea;
    const bounds = computePopoverBounds({
      anchor,
      window: { x: contentBounds.x, y: contentBounds.y },
      size: Windows.POPOVER_SIZE,
      workArea,
    });
    const popover = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      parent: window,
      title: 'WSL Web Shell — Settings',
      backgroundColor: '#11161f',
      hasShadow: true,
      webPreferences: {
        preload: join(this.options.preloadDir, 'popover.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        devTools: this.options.devToolsEnabled,
      },
    });
    popover.setMenuBarVisibility(false);
    popover.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    popover.webContents.on('will-navigate', (event, url) => {
      if (url.startsWith('file://')) return;
      event.preventDefault();
    });
    popover.loadFile(join(this.options.rendererDir, 'popover', 'index.html')).catch((error: unknown) => {
      this.options.log.error(`settings popover failed to load: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    popover.once('ready-to-show', () => popover.show());
    popover.on('blur', () => this.closeSettingsPopover());
    popover.on('closed', () => {
      if (this.popover === popover) this.popover = null;
      this.popoverClosedAt = Date.now();
    });
    this.popover = popover;
  }

  closeSettingsPopover(): void {
    const popover = this.popover;
    if (popover === null) return;
    this.popover = null;
    this.popoverClosedAt = Date.now();
    if (!popover.isDestroyed()) popover.destroy();
  }

  private static readonly POPOVER_SIZE = { width: 360, height: 460 };


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
   * When the app is hidden it is created without activation, so an always-on-top
   * window never pops over the desktop uninvited.
   */
  showSplash(options: SplashOptions): void {
    if (this.splash !== null && !this.splash.isDestroyed()) {
      if (options.activate) {
        this.splash.show();
        this.splash.focus();
      } else {
        this.splash.hide();
      }
      if (this.status !== null) this.publishStatus(this.status);
      return;
    }
    const window = new BrowserWindow({
      width: 440,
      height: 320,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
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
      if (options.activate) window.show();
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
    for (const window of [this.main, this.splash, this.settings]) {
      if (window === null || window.isDestroyed()) continue;
      window.webContents.send('shell:status', status);
    }
  }

  /** Push the installed/upstream version snapshot to the footer. */
  publishVersions(snapshot: VersionSnapshot): void {
    this.versions = snapshot;
    const window = this.mainWindow;
    if (window === null || window.webContents.isDestroyed()) return;
    window.webContents.send('footer:versions', snapshot);
  }

  /** Re-send the current status and versions after a (re)load of the footer. */
  private replayFooterState(): void {
    const window = this.mainWindow;
    if (window === null || window.webContents.isDestroyed()) return;
    if (this.status !== null) window.webContents.send('shell:status', this.status);
    if (this.versions !== null) window.webContents.send('footer:versions', this.versions);
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
    const view = this.ensureBackendView();
    const contents = view.webContents;
    const target = `${origin}/`;
    const current = contents.getURL();
    const alreadyThere = current === target || current === origin;
    if (alreadyThere && options.force !== true) return;
    if (this.loadInFlight !== null) {
      // Never race two navigations; a forced reload still happens afterwards,
      // because the in-flight document may predate the backend restart.
      await this.loadInFlight;
      if (options.force !== true) return;
    }
    const navigation = contents
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
    this.closeSettingsPopover();
    this.destroyBackendView();
    for (const window of [this.settings, this.splash, this.main]) {
      if (window !== null && !window.isDestroyed()) window.destroy();
    }
    this.settings = null;
    this.splash = null;
    this.main = null;
  }
}
