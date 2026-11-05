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

export const PARTITION = 'persist:wsl-web-shell';

export interface WindowsOptions {
  rendererDir: string;
  preloadDir: string;
  log: Logger;
  origin(): string;
  onRendererGone(reason: string): void;
  onExternalLink(url: string): void;
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
        devTools: true,
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
      // Close always hides to tray; only the explicit Quit path destroys it.
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
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

  /** Harden the shared session: deny permissions outside the allowlist. */
  configureSession(): Session {
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

  /** Splash doubles as the reconnect overlay while the backend recovers. */
  showSplash(): void {
    if (this.splash !== null && !this.splash.isDestroyed()) {
      this.splash.show();
      this.splash.focus();
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
      },
    });
    window.loadFile(join(this.options.rendererDir, 'splash', 'index.html')).catch((error: unknown) => {
      this.options.log.error(`splash load failed: ${error instanceof Error ? error.message : 'unknown'}`);
    });
    window.once('ready-to-show', () => {
      window.show();
      if (this.status !== null) this.publishStatus(this.status);
    });
    window.on('closed', () => {
      this.splash = null;
    });
    this.splash = window;
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
      height: 640,
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

  async loadBackend(origin: string): Promise<void> {
    const window = this.ensureMain();
    const current = window.webContents.getURL();
    if (current === `${origin}/` || current === origin) {
      return;
    }
    await window.loadURL(`${origin}/`);
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
