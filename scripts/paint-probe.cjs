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
  // Sample points are DIP; the captured image is in device pixels.
  const scale = display.scaleFactor;
  return {
    size,
    scale,
    pixel(x, y) {
      // `thumbnailSize` is requested in DIP, so sample points stay in DIP.
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

/** Read the pixels that matter for one window (no side effects). */
async function sampleWindow(window) {
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
    topLeft: [Math.round(content.x + 6), Math.round(content.y + 6)],
    outside: [Math.round(content.x / 2), Math.round(content.y / 2)],
  };
  const base = { content, childViews, samples };
  let shot;
  try {
    shot = await captureScreen();
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
  if (shot === null) return { ...base, error: 'no screen source' };
  const webuiPixels = shot.pixel(samples.webui[0], samples.webui[1]);
  const barPixels = shot.pixel(samples.bar[0], samples.bar[1]);
  return {
    ...base,
    shot,
    screen: shot.size,
    scale: shot.scale,
    probePixels: {
      topLeft: shot.pixel(samples.topLeft[0], samples.topLeft[1]),
      outside: shot.pixel(samples.outside[0], samples.outside[1]),
    },
    webuiPixels,
    barPixels,
    webuiVisible: near(webuiPixels, WEBUI_COLOR),
    // The bar sample proves the capture itself works (the app-owned page paints).
    captureWorks: barPixels !== null && !near(barPixels, WEBUI_COLOR),
  };
}

/**
 * Wait until the remote surface is really on screen.
 *
 * A software-composited first window can need seconds for its first frame
 * (shader warm-up), so a fixed delay produces false negatives.
 */
async function waitForPaint(window, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let sample = await sampleWindow(window);
  while (sample.error === undefined && sample.webuiVisible !== true && Date.now() < deadline) {
    await settle(500);
    sample = await sampleWindow(window);
  }
  if (outDir !== null && sample.error === undefined) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `${label}.png`), sample.shot.source.thumbnail.toPNG());
    try {
      writeFileSync(join(outDir, `${label}-window.png`), (await window.capturePage()).toPNG());
    } catch {
      // Window-surface capture is unavailable in some environments; the screen
      // pixels above are the authoritative evidence.
    }
  }
  return {
    label,
    capture: sample.error !== undefined ? 'unavailable' : sample.captureWorks === true ? 'ok' : 'suspicious',
    error: sample.error,
    content: sample.content,
    childViews: sample.childViews,
    samples: sample.samples,
    probePixels: sample.probePixels,
    screen: sample.screen,
    scale: sample.scale,
    webuiPixels: sample.webuiPixels ?? null,
    barPixels: sample.barPixels ?? null,
    pass: sample.error === undefined && sample.webuiVisible === true && sample.captureWorks === true,
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

/**
 * Production order on a cold start: READY loads the WebUI before the window is
 * shown, so the view is created while no window exists yet.
 */
function buildColdStart({ dist, origin }) {
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
  return {
    // getter stays lazy: the view must exist before any window does
    ready: async () => {
      await windows.loadBackend(origin);
      const window = windows.ensureMain();
      fitToScreen(window);
      windows.showMain();
      return window;
    },
    cleanup: () => {
      windows.destroyAll();
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

const VARIANTS = {
  coldStart: buildColdStart,
  baseline: buildBaseline,
  // Second identical window: distinguishes a compositor warm-up from a bug.
  baseline2: buildBaseline,
  reapply: buildReapply,
  sibling: buildSibling,
};

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
      const window = (await built.ready()) ?? built.window;
      results.push(await waitForPaint(window, name));
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
        `barPixel=${JSON.stringify(result.barPixels ?? null)} probes=${JSON.stringify(result.probePixels ?? null)} ` +
        `screen=${JSON.stringify(result.screen ?? null)} scale=${result.scale ?? 'n/a'} views=${JSON.stringify(result.childViews ?? null)} ` +
        `content=${JSON.stringify(result.content ?? null)}${result.error === undefined ? '' : ` error=${result.error}`}`,
    );
  }
  console.log(`paint probe: ${results.length - failed}/${results.length} variants painted`);
  app.exit(failed === 0 ? 0 : 1);
});
