/*
 * Integration check of the real window composition (issue #9).
 *
 * Unlike `chrome:smoke` (which renders pages in isolation), this builds the real
 * `Windows` class from `src/main/electron/windows.ts` and drives it the way the
 * app does: a `BrowserWindow` with the app-owned footer page, a `WebContentsView`
 * for the remote WebUI on the production partition, the production preloads and
 * the production layout function.
 *
 * A local HTTP server stands in for `dsh web`: it issues a session cookie on the
 * first request and answers 401 when a later request carries a wrong one, so
 * cookie continuity can be asserted end to end. No WSL, no DeepSeek Harness and
 * no network access are involved.
 *
 *   npm run composition:smoke
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { join } = require('node:path');

// Software rendering only: hidden Xvfb displays have no GPU process.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const root = join(__dirname, '..');
const dist = join(root, 'dist');
const { Windows, PARTITION, FOOTER_HEIGHT } = require(join(dist, 'test', 'composition.cjs'));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

// The harness destroys its own windows at the end; without this, Electron's
// default `window-all-closed` handling would quit mid-run.
app.on('window-all-closed', () => undefined);

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, tries = 60, delay = 50) {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = await predicate();
    if (value) return value;
    await settle(delay);
  }
  return null;
}

/** Minimal stand-in for `dsh web`: one page plus a session cookie. */
function startBackend() {
  const state = { issued: null, requests: 0, unauthorised: 0, cookies: [] };
  const server = createServer((request, response) => {
    state.requests += 1;
    const header = request.headers.cookie ?? '';
    state.cookies.push(header);
    const match = /wss_session=([0-9a-f-]+)/.exec(header);
    if (match === null) {
      // First visit: pretend the app just exchanged its launch token for a cookie.
      state.issued = randomUUID();
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `wss_session=${state.issued}; Path=/; HttpOnly; SameSite=Lax`,
      });
      response.end(`<!doctype html><title>Test WebUI</title><h1>Test WebUI</h1><p id="session">new</p>`);
      return;
    }
    if (match[1] !== state.issued) {
      state.unauthorised += 1;
      response.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>401</title><p id="session">unauthorised</p>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><title>Test WebUI</title><h1>Test WebUI</h1><p id="session">known:${match[1]}</p>`,
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, state, origin: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** The single child view the app adds for the remote WebUI. */
function backendView(window) {
  const children = window.contentView.children ?? [];
  return children.length === 1 ? children[0] : null;
}

async function text(view, selector) {
  return view.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`,
    true,
  );
}

async function barRect(window) {
  return window.webContents.executeJavaScript(
    `(() => {
      const bar = document.querySelector('#bar');
      if (!bar) return null;
      const rect = bar.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    })()`,
    true,
  );
}

async function main() {
  const backend = await startBackend();
  const origin = backend.origin;

  // The footer and the popover talk to the main process exactly like in the app;
  // these are the same channels, answered with a fixed snapshot.
  const status = {
    state: 'READY',
    detail: null,
    distro: 'Ubuntu',
    port: Number(new URL(origin).port),
    pid: 4242,
    origin,
    dshVersion: '0.2.1-rc.5',
    updatedAt: new Date().toISOString(),
  };
  const versions = {
    installed: '0.2.1-rc.5',
    latest: {
      version: '0.2.2-rc.1',
      url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
      prerelease: true,
      publishedAt: '2026-11-04T09:12:00.000Z',
    },
    checkedAt: new Date().toISOString(),
    error: null,
    updateAvailable: true,
  };
  const config = {
    distro: 'Ubuntu',
    port: Number(new URL(origin).port),
    workspace: '/home/tester/projects/harness',
    dshPath: null,
    isolateEnvironment: true,
    runtimeRoot: '~/.local/share/wsl-web-shell',
    openOnLaunch: true,
    autoRestart: true,
    maxRestartAttempts: 3,
  };
  ipcMain.handle('footer:status', () => status);
  ipcMain.handle('footer:versions', () => versions);
  ipcMain.handle('footer:toggle-settings', () => undefined);
  ipcMain.handle('footer:open-release', () => undefined);
  ipcMain.handle('popover:close', () => undefined);
  ipcMain.handle('settings:open-window', () => undefined);
  ipcMain.handle('settings:distros', () => ['Ubuntu']);
  ipcMain.handle('settings:load', () => ({ config, distros: ['Ubuntu'], status, restartRequired: false }));
  ipcMain.handle('settings:save', () => ({ ok: true, errors: [], restartRequired: false, config }));

  const windows = new Windows({
    rendererDir: dist,
    preloadDir: join(dist, 'preload'),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, path: () => '', tail: () => '' },
    origin: () => origin,
    devToolsEnabled: true,
    onRendererGone: (reason) => check('renderer stayed alive', false, reason),
    onExternalLink: () => undefined,
    onVisibilityChanged: () => undefined,
  });
  windows.configureSession();
  const window = windows.ensureMain();
  windows.showMain();
  windows.publishStatus(status);
  windows.publishVersions(versions);
  await settle(600);

  // --- composition ----------------------------------------------------------
  const view = backendView(window);
  check('the window hosts exactly one child view for the WebUI', view !== null);
  check('the window itself shows the app-owned bar, not the remote page',
    window.webContents.getURL().endsWith('/chrome/index.html'), window.webContents.getURL());
  check('the bar and the WebUI are separate web contents', view?.webContents !== window.webContents);
  check('the WebUI uses the production partition',
    view?.webContents.session === session.fromPartition(PARTITION));

  // --- footer bar -----------------------------------------------------------
  const [contentWidth, contentHeight] = window.getContentSize();
  const rect = await barRect(window);
  check('the bar is 30-34 px tall', rect !== null && rect.height >= 30 && rect.height <= 34, JSON.stringify(rect));
  check('the bar sits at the bottom of the window',
    rect !== null && Math.round(rect.bottom) === contentHeight && Math.round(rect.height) === FOOTER_HEIGHT,
    `${JSON.stringify(rect)} content=${contentWidth}x${contentHeight}`);

  const endpoint = await until(async () =>
    (await text(window, '#endpoint')).includes(':') ? text(window, '#endpoint') : null,
  );
  check('the bar shows the WSL distro and port', endpoint === `WSL Ubuntu :${status.port}`, String(endpoint));
  const stateLabel = await text(window, '#conn-label');
  check('the bar shows the published state', stateLabel === 'Connected', stateLabel);
  const installed = await text(window, '#installed');
  check('the bar shows the running DSH version', installed.includes('0.2.1-rc.5'), installed);

  // --- WebUI bounds ---------------------------------------------------------
  const bounds = view.getBounds();
  check('the WebUI starts directly under the window top', bounds.x === 0 && bounds.y === 0, JSON.stringify(bounds));
  check('the WebUI keeps the full width', bounds.width === contentWidth, JSON.stringify(bounds));
  check('the WebUI ends exactly where the bar starts',
    bounds.height === contentHeight - FOOTER_HEIGHT, `${JSON.stringify(bounds)} content=${contentWidth}x${contentHeight}`);
  check('the WebUI never overlaps the bar', bounds.height + FOOTER_HEIGHT <= contentHeight);

  // --- remote page ----------------------------------------------------------
  await windows.loadBackend(origin);
  check('the remote page is loaded in the view', view.webContents.getURL() === `${origin}/`, view.webContents.getURL());
  const firstSession = await until(async () => {
    const value = await text(view, '#session');
    return value === 'new' ? value : null;
  });
  check('the test backend answered the first load', firstSession === 'new', String(firstSession));

  const cookies = await session.fromPartition(PARTITION).cookies.get({ url: `${origin}/` });
  const cookie = cookies.find((entry) => entry.name === 'wss_session');
  check('the session cookie is stored in the app partition', cookie?.value === backend.state.issued, JSON.stringify(cookie?.value));

  // --- resize ---------------------------------------------------------------
  const resizeTo = async (width, height) => {
    window.setContentSize(width, height);
    return until(() => {
      const current = view.getBounds();
      return current.height === height - FOOTER_HEIGHT && current.width === width ? current : null;
    });
  };
  const large = await resizeTo(940, 620);
  check('a larger window re-lays out the WebUI', large !== null, JSON.stringify(view.getBounds()));
  const largeRect = await barRect(window);
  check('the bar follows the window size', largeRect !== null && Math.round(largeRect.bottom) === 620, JSON.stringify(largeRect));
  const small = await resizeTo(760, 520);
  check('a smaller window re-lays out the WebUI', small !== null, JSON.stringify(view.getBounds()));
  const restored = await resizeTo(1000, 700);
  check('the WebUI returns to the original geometry', restored !== null, JSON.stringify(view.getBounds()));

  // --- session continuity ---------------------------------------------------
  const before = backend.state.requests;
  await windows.loadBackend(origin, { force: true });
  const afterReload = await until(async () => {
    const value = await text(view, '#session');
    return value.startsWith('known:') ? value : null;
  });
  check('a reload reuses the existing session', afterReload === `known:${backend.state.issued}`, String(afterReload));
  check('the reload really hit the backend', backend.state.requests > before, `${before} -> ${backend.state.requests}`);
  check('no request was rejected with 401', backend.state.unauthorised === 0, String(backend.state.unauthorised));
  check('the cookie survived the reload',
    (await session.fromPartition(PARTITION).cookies.get({ url: `${origin}/` })).some(
      (entry) => entry.name === 'wss_session' && entry.value === backend.state.issued,
    ));

  // --- settings popover status refresh --------------------------------------
  windows.toggleSettingsPopover({ x: 900, y: 660, width: 24, height: 22 });
  const popover = windows.settingsPopoverOpen;
  check('the settings popover opens from the bar', popover === true);
  if (popover) {
    // The popover window appears asynchronously (ready-to-show), so look it up on
    // every read instead of capturing it once.
    const popoverContents = () =>
      BrowserWindow.getAllWindows().find(
        (candidate) =>
          !candidate.isDestroyed() && candidate.webContents.getURL().endsWith('/popover/index.html'),
      ) ?? null;
    const readPopoverState = async () => {
      const target = popoverContents();
      if (target === null) return '';
      try {
        return await target.webContents.executeJavaScript(
          "document.querySelector('#stateLabel')?.textContent ?? ''",
          true,
        );
      } catch {
        return '';
      }
    };
    const initial = await until(async () => {
      const value = await readPopoverState();
      return value.includes('Connected') ? value : null;
    });
    check('the popover is pre-filled with the current state', initial !== null, String(initial));

    // The regression this guards: a status published while the popover is open
    // must reach it (the popover is a separate window).
    windows.publishStatus({ ...status, state: 'RECOVERING', detail: 'backend restarting' });
    const updated = await until(async () => {
      const value = await readPopoverState();
      return value.includes('Reconnecting') ? value : null;
    });
    check('a status change reaches the open popover', updated !== null, String(updated));
    windows.closeSettingsPopover();
  }

  // --- shutdown -------------------------------------------------------------
  windows.setQuitting();
  window.destroy();
  await settle(100);
  // Destroying the window releases the child view as well; after that the view's
  // own webContents is gone, so treat "no webContents left" as destroyed.
  const contentsGone = view.webContents === undefined || view.webContents.isDestroyed();
  check('the view is destroyed with its window', window.isDestroyed() && contentsGone);
  backend.server.close();
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(`composition smoke failed: ${error instanceof Error ? error.stack : String(error)}`);
    check('the composition harness completed', false, error instanceof Error ? error.message : String(error));
    exitCode = 1;
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) exitCode = 1;
  console.log(
    exitCode === 0
      ? `composition smoke: ok (${results.length} checks)`
      : `composition smoke: ${failed.length} of ${results.length} checks failed`,
  );
  app.exit(exitCode);
});
