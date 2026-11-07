/**
 * Real-pixel composition probe.
 *
 * The composition smoke asserts geometry, DOM and cookies; it cannot tell
 * whether the remote WebUI surface is actually painted on screen. This probe
 * does: it composes a window exactly like the app does, then reads the pixels
 * the operating system really shows for that window.
 *
 * Capture path: `desktopCapturer` screen source (available on every platform,
 * no window manager needed) cropped to the window's content rectangle.
 *
 * Variants:
 *   baseline  - the production order: hidden window, view added, then shown.
 *   reapply   - baseline plus bounds/top re-application after the window shows.
 *   sibling   - both the bar and the WebUI are child views of one window.
 *
 * Usage:
 *   electron scripts/paint-probe.cjs --variant baseline [--out dir]
 *   electron scripts/paint-probe.cjs --variant all
 *
 * Exit code is 0 only when every requested variant paints the remote page.
 */
'use strict';

const { createServer } = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { app, BrowserWindow, WebContentsView, desktopCapturer, ipcMain, screen } = require('electron');

const WEBUI_COLOR = [0, 192, 192];
const TOLERANCE = 24;
const SETTLE_MS = 2500;

const variantArg = readArg('--variant') ?? 'all';
const outDir = readArg('--out') ?? 'paint-probe';

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startColorServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:rgb(${WEBUI_COLOR.join(',')})}</style>` +
        '<h1 style="font:32px sans-serif;color:#fff">REMOTE WEBUI</h1>',
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

/** Capture the primary display and return a pixel reader, or null. */
async function captureScreen() {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: display.size.width, height: display.size.height },
  });
  const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
  if (source === undefined) return null;
  const image = source.thumbnail;
  const size = image.getSize();
  const bitmap = image.getBitmap();
  return {
    size,
    pixel(x, y) {
      const px = Math.round(x);
      const py = Math.round(y);
      if (px < 0 || py < 0 || px >= size.width || py >= size.height) return null;
      // NativeImage exposes the raw platform bitmap, which is BGRA in practice.
      const offset = (py * size.width + px) * 4;
      return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]];
    },
    source,
  };
}

function near(actual, expected, tolerance = TOLERANCE) {
  if (actual === null) return false;
  return actual.every((value, index) => Math.abs(value - expected[index]) <= tolerance);
}

function stubIpc() {
  for (const channel of [
    'footer:status',
    'footer:versions',
    'footer:toggle-settings',
    'footer:open-release',
    'popover:close',
    'settings:open-window',
    'settings:distros',
    'settings:load',
    'settings:save',
  ]) {
    try {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => null);
    } catch {
      // Handler already registered by an earlier variant.
    }
  }
}

/** Sample the pixels that matter for one window and classify the result. */
async function inspectWindow(window, label) {
  const content = window.getContentBounds();
  const childViews = window.contentView.children.map((child) => {
    try {
      return child.getBounds();
    } catch {
      return 'n/a';
    }
  });
  const samples = {
    webui: [Math.round(content.x + content.width / 2), Math.round(content.y + Math.round(content.height / 2) - 8)],
    bar: [Math.round(content.x + content.width / 2), Math.round(content.y + content.height - 16)],
  };
  let shot;
  try {
    shot = await captureScreen();
  } catch (error) {
    return {
      label,
      capture: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
      content,
      childViews,
      samples,
    };
  }
  if (shot === null) return { label, capture: 'unavailable', content, samples, webuiPixels: null, barPixels: null };
  const webuiPixels = shot.pixel(samples.webui[0], samples.webui[1]);
  const barPixels = shot.pixel(samples.bar[0], samples.bar[1]);
  if (outDir !== null) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${label}.png`), shot.source.thumbnail.toPNG());
  }
  const webuiVisible = near(webuiPixels, WEBUI_COLOR);
  // The bar sample proves the capture itself works (the app-owned page paints).
  const captureWorks = barPixels !== null && !near(barPixels, WEBUI_COLOR);
  return {
    label,
    capture: captureWorks ? 'ok' : 'suspicious',
    content,
    childViews,
    samples,
    webuiPixels,
    barPixels,
    webuiVisible,
    pass: webuiVisible && captureWorks,
  };
}

/** Fit a window into the current screen so every sample point stays on-screen. */
function fitToScreen(window) {
  const work = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.max(720, Math.min(1280, work.width - 60));
  const height = Math.max(520, Math.min(860, work.height - 60));
  window.setBounds({ x: 30, y: 30, width, height });
}

/** Variant builders: each returns `{ window, cleanup }`. */
function buildBaseline({ dist, origin }) {
  const { Windows } = require(join(dist, 'test', 'composition.cjs'));
  const windows = new Windows({
    rendererDir: dist,
    preloadDir: join(dist, 'preload'),
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, path: () => '', tail: () => '' },
    origin: () => origin,
    devToolsEnabled: true,
    onRendererGone: () => {},
    onExternalLink: () => {},
    onVisibilityChanged: () => {},
  });
  windows.configureSession();
  const window = windows.ensureMain();
  fitToScreen(window);
  windows.showMain();
  return {
    window,
    ready: () => windows.loadBackend(origin),
    cleanup: () => {
      windows.destroyAll();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

function buildReapply({ dist, origin }) {
  const baseline = buildBaseline({ dist, origin });
  return {
    ...baseline,
    ready: async () => {
      await baseline.ready();
      await settle(300);
      // Re-assert geometry and stacking after the window became visible.
      const view = baseline.window.contentView.children[0];
      if (view !== undefined) {
        baseline.window.contentView.removeChildView(view);
        baseline.window.contentView.addChildView(view);
        const size = baseline.window.getContentSize();
        view.setBounds({ x: 0, y: 0, width: size[0], height: Math.max(0, size[1] - 32) });
      }
    },
  };
}

function buildSibling({ origin }) {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    x: 40,
    y: 40,
    show: false,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b0f16',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.loadURL('data:text/html,<style>html,body{margin:0;height:100%;background:#0b0f16}</style>');
  const bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  const barReady = bar.webContents.loadURL('data:text/html,<style>html,body{margin:0;height:100%;background:#0d1219}</style>');
  const webui = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, partition: 'persist:paint-probe' } });
  const place = () => {
    const size = window.getContentSize();
    bar.setBounds({ x: 0, y: size[1] - 32, width: size[0], height: 32 });
    webui.setBounds({ x: 0, y: 0, width: size[0], height: Math.max(0, size[1] - 32) });
  };
  window.contentView.addChildView(bar);
  window.contentView.addChildView(webui);
  place();
  window.on('resize', place);
  fitToScreen(window);
  window.show();
  return {
    window,
    ready: async () => {
      await Promise.all([barReady, webui.webContents.loadURL(origin)]);
      place();
    },
    cleanup: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

const VARIANTS = { baseline: buildBaseline, reapply: buildReapply, sibling: buildSibling };

app.on('window-all-closed', () => undefined);

app.whenReady().then(async () => {
  const dist = join(__dirname, '..', 'dist');
  const server = await startColorServer();
  stubIpc();
  const names = variantArg === 'all' ? Object.keys(VARIANTS) : [variantArg];
  const results = [];
  for (const name of names) {
    const builder = VARIANTS[name];
    if (builder === undefined) {
      results.push({ label: name, pass: false, error: `unknown variant ${name}` });
      continue;
    }
    try {
      const built = builder({ dist, origin: server.origin });
      await built.ready();
      await settle(SETTLE_MS);
      results.push(await inspectWindow(built.window, name));
      built.cleanup();
      await settle(600);
    } catch (error) {
      results.push({ label: name, pass: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  server.close();
  let failed = 0;
  for (const result of results) {
    const status = result.pass === true ? 'PASS' : 'FAIL';
    if (result.pass !== true) failed += 1;
    console.log(
      `${status} ${result.label}: capture=${result.capture ?? 'n/a'} webuiPixel=${JSON.stringify(result.webuiPixels ?? null)} ` +
        `barPixel=${JSON.stringify(result.barPixels ?? null)} views=${JSON.stringify(result.childViews ?? null)} ` +
        `content=${JSON.stringify(result.content ?? null)}${result.error === undefined ? '' : ` error=${result.error}`}`,
    );
  }
  console.log(`paint probe: ${results.length - failed}/${results.length} variants painted`);
  app.exit(failed === 0 ? 0 : 1);
});
