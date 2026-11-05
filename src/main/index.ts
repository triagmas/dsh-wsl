/**
 * Electron main entry point.
 *
 * Owns the single-instance lock, the supervisor lifetime, the tray, the
 * sandboxed backend window and the local splash/settings surfaces.
 */
import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { applyConfigPatch, requiresRestart } from './core/config.js';
import { createLogger } from './core/logger.js';
import { probePort } from './core/port.js';
import { createFileRegistry } from './core/registry.js';
import { ShellError, Supervisor } from './core/supervisor.js';
import { buildOrigin } from './backend/urls.js';
import { createWslGateway } from './wsl/gateway.js';
import { createConfigStore } from './electron/config-store.js';
import { createWebClient } from './electron/web-client.js';
import { TrayController } from './electron/tray.js';
import { Windows } from './electron/windows.js';
import type { AppConfig, ConfigPatch, ShellStatus } from '../shared/types.js';

const APP_ID = 'com.triagmas.wslwebshell';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId(APP_ID);

  const userData = app.getPath('userData');
  const logPath = join(userData, 'logs', 'app.log');
  const log = createLogger(logPath);
  log.info(`wsl-web-shell ${app.getVersion()} starting (pid=${process.pid})`);

  const configStore = createConfigStore(join(userData, 'config.json'));
  let config: AppConfig = configStore.load();
  const registry = createFileRegistry(join(userData, 'owned-server.json'));
  const rendererDir = join(__dirname, '..');
  const preloadDir = join(__dirname, '..', 'preload');

  // Origin of the running backend; updated from every status snapshot so the
  // navigation guard always matches the page that is actually loaded.
  let activePort = config.port;

  const windows = new Windows({
    rendererDir,
    preloadDir,
    log,
    origin: () => buildOrigin(activePort),
    onRendererGone: () => {
      log.warn('renderer process gone; health supervisor will decide on recovery');
    },
    onExternalLink: (url) => windows.openExternal(url),
  });

  const backendSession = windows.configureSession();
  const web = createWebClient(() => backendSession, log);
  const wsl = createWslGateway({ log });

  let tray: TrayController | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let quitting = false;

  const supervisor: Supervisor = new Supervisor({
    config: () => config,
    wsl,
    web,
    registry,
    log,
    probePort,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    appVersion: app.getVersion(),
    logPath: () => logPath,
    publish: (status) => {
      activePort = status.port;
      windows.publishStatus(status);
      tray?.update(status, windows.isMainVisible());
      onStatusChange(status);
    },
  });

  const onStatusChange = (status: ShellStatus): void => {
    switch (status.state) {
      case 'READY':
        windows.closeSplash();
        void windows.loadBackend(buildOrigin(status.port)).catch((error: unknown) => {
          log.error(`loading WebUI failed: ${error instanceof Error ? error.name : 'error'}`);
        });
        if (config.openOnLaunch) windows.showMain();
        break;
      case 'RECOVERING':
      case 'ERROR':
        windows.showSplash();
        break;
      case 'QUITTING':
        windows.closeSplash();
        break;
      default:
        break;
    }
    scheduleHealthChecks();
  };

  const scheduleHealthChecks = (): void => {
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    if (quitting) return;
    const status = supervisor.getStatus();
    if (status.state !== 'READY' && status.state !== 'HIDDEN_IN_TRAY') return;
    const interval = status.state === 'READY' ? 10_000 : 25_000;
    healthTimer = setTimeout(() => {
      void supervisor.healthTick().finally(() => scheduleHealthChecks());
    }, interval);
    healthTimer.unref?.();
  };

  const quit = (): void => {
    if (quitting) return;
    quitting = true;
    log.info('quit requested');
    if (healthTimer !== null) clearTimeout(healthTimer);
    healthTimer = null;
    windows.setQuitting();
    tray?.destroy();
    tray = null;
    void supervisor
      .shutdown()
      .catch((error: unknown) => {
        log.error(`shutdown failed: ${error instanceof Error ? error.message : 'unknown'}`);
      })
      .finally(() => {
        windows.destroyAll();
        app.quit();
      });
  };

  tray = new TrayController({
    iconPath: join(rendererDir, 'assets', 'tray.png'),
    log: (message) => log.info(message),
    handlers: {
      open: () => {
        const state = supervisor.getStatus().state;
        if (state === 'ERROR' || state === 'RECOVERING') {
          // Nothing loadable yet: keep the actionable overlay in front.
          windows.showSplash();
          return;
        }
        windows.showMain();
        if (state === 'READY' || state === 'HIDDEN_IN_TRAY') {
          void supervisor.healthTick().catch(() => undefined);
        }
      },
      status: () => {
        const status = supervisor.getStatus();
        const lines = [
          `State: ${status.state}`,
          `Message: ${status.message}`,
          status.detail === null ? null : `Detail: ${status.detail}`,
          `Distribution: ${status.distro}`,
          `Port: ${status.port}`,
          `Backend managed by this app: ${status.ownedServer ? 'yes' : 'no'}`,
          `Log: ${logPath}`,
        ].filter((line): line is string => line !== null);
        void dialog.showMessageBox({
          type: status.state === 'ERROR' ? 'error' : 'info',
          title: 'WSL Web Shell — Connection status',
          message: status.message,
          detail: lines.join('\n'),
          buttons: ['OK'],
        });
      },
      restart: () => {
        const state = supervisor.getStatus().state;
        if (state === 'ERROR') void supervisor.retry().catch(() => undefined);
        else void supervisor.restart().catch(() => undefined);
      },
      settings: () => windows.openSettings(),
      quit,
    },
  });
  tray.create();
  tray.update(supervisor.getStatus(), false);

  const isTrustedSender = (event: IpcMainInvokeEvent): boolean => {
    const url = event.senderFrame?.url ?? '';
    return url.startsWith('file://');
  };

  const guard = <T>(channel: string, handler: (event: IpcMainInvokeEvent) => Promise<T> | T): void => {
    ipcMain.handle(channel, async (event) => {
      if (!isTrustedSender(event)) {
        log.warn(`rejected ${channel} from untrusted sender`);
        throw new Error('untrusted-sender');
      }
      return await handler(event);
    });
  };

  guard('shell:status:get', () => supervisor.getStatus());

  guard('shell:retry', async () => {
    await supervisor.retry().catch(() => undefined);
  });

  guard('shell:open-logs', async () => {
    await shell.openPath(join(userData, 'logs'));
  });

  guard('shell:quit', () => {
    quit();
  });

  guard('settings:load', async () => ({
    config,
    distros: await wsl.listDistros().catch((error: unknown) => {
      log.warn(`listing distributions failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return [] as string[];
    }),
    status: supervisor.getStatus(),
    configPath: configStore.path(),
  }));

  guard('settings:distros', async () => wsl.listDistros().catch(() => [] as string[]));

  guard('settings:open-config', async () => {
    await shell.openPath(userData);
  });

  guard('settings:close', () => {
    windows.closeSettingsWindow();
  });

  ipcMain.handle('settings:save', async (event, patch: unknown) => {
    if (!isTrustedSender(event)) throw new Error('untrusted-sender');
    return await saveConfig(patch);
  });

  async function saveConfig(rawPatch: unknown): Promise<{
    ok: boolean;
    errors: string[];
    restartRequired: boolean;
    config: AppConfig;
  }> {
    if (rawPatch === null || typeof rawPatch !== 'object') {
      return { ok: false, errors: ['invalid settings payload'], restartRequired: false, config };
    }
    const patch = rawPatch as ConfigPatch;
    if (typeof patch.port !== 'undefined') {
      const port = Number(patch.port);
      if (Number.isInteger(port) && port > 0) {
        const taken = await probePort(port).catch(() => 'occupied' as const);
        if (taken === 'occupied' && port !== config.port) {
          return {
            ok: false,
            errors: [`port ${port} is already in use; stop the other service or choose a free port`],
            restartRequired: false,
            config,
          };
        }
      }
    }
    const result = applyConfigPatch(config, patch);
    if (result.errors.length > 0) {
      return { ok: false, errors: result.errors, restartRequired: false, config };
    }
    const restartRequired = requiresRestart(config, result.config);
    config = result.config;
    configStore.save(config);
    log.info('settings saved');
    if (restartRequired) log.info('backend restart required to apply new settings');
    return { ok: true, errors: [], restartRequired, config };
  }

  app.on('second-instance', () => {
    windows.showMain();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit();
  });

  app.on('window-all-closed', () => {
    // Tray application: closing every window must keep the supervisor alive.
  });

  app.on('activate', () => windows.showMain());

  app.whenReady().then(async () => {
    windows.showSplash();
    tray?.update(supervisor.getStatus(), false);
    try {
      await supervisor.start();
    } catch (error) {
      log.error(
        `startup failed: ${error instanceof ShellError ? `${error.code}: ${error.message}` : String(error)}`,
      );
    }
  });
}
