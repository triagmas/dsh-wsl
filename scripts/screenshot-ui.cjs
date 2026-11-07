/*
 * Headless check of the app-owned chrome (issue #9), and the source of the
 * screenshots in docs/media.
 *
 * It loads the shipped footer and popover pages with their shipped preloads and
 * answers the IPC channels with fixed test data — no WSL, no DeepSeek Harness, no
 * owner desktop. After loading, it asserts what the pages actually rendered and
 * exercises the popover's save path, so a broken footer fails in CI instead of
 * only looking wrong in a picture.
 *
 *   npm run chrome:smoke      render + assert (used by CI)
 *   npm run screenshots       render + assert + write docs/media/*.png
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

// Software rendering only: capturePage under Xvfb fails with a viz error when a
// GPU process is involved.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');

const root = join(__dirname, '..');
const dist = join(root, 'dist');
const outDir = join(root, 'docs', 'media');
const scratch = mkdtempSync(join(tmpdir(), 'wsl-web-shell-shots-'));
const WIDTH = 1100;
const HEIGHT = 700;
const FOOTER_HEIGHT = 32;
const POPOVER = { width: 360, height: 460 };
const writeImages = process.argv.includes('--write-images');

const status = {
  state: 'READY',
  detail: null,
  distro: 'Ubuntu',
  port: 3080,
  pid: 48211,
  origin: 'http://127.0.0.1:3080/',
  dshVersion: '0.2.1-rc.5',
  updatedAt: '2026-11-06T13:41:00.000Z',
};

const versions = {
  installed: '0.2.1-rc.5',
  latest: {
    version: '0.2.2-rc.1',
    url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.1',
    prerelease: true,
    publishedAt: '2026-11-04T09:12:00.000Z',
  },
  checkedAt: '2026-11-06T13:41:02.000Z',
  error: null,
  updateAvailable: true,
};

const config = {
  distro: 'Ubuntu',
  port: 3080,
  workspace: '/home/tester/projects/harness',
  dshPath: null,
  isolateEnvironment: true,
  runtimeRoot: '~/.local/share/wsl-web-shell',
  openOnLaunch: true,
  autoRestart: true,
  maxRestartAttempts: 3,
};

/** Patches received through `settings:save`, asserted below. */
const saves = [];
let releaseOpened = 0;
let popoverCloseCalls = 0;

function registerIpc() {
  ipcMain.handle('footer:status', () => status);
  ipcMain.handle('footer:versions', () => versions);
  ipcMain.handle('footer:toggle-settings', () => undefined);
  ipcMain.handle('footer:open-release', () => {
    releaseOpened += 1;
  });
  ipcMain.handle('popover:close', () => {
    popoverCloseCalls += 1;
  });
  ipcMain.handle('settings:open-window', () => undefined);
  ipcMain.handle('settings:distros', () => ['Ubuntu', 'Ubuntu-24.04', 'Debian']);
  ipcMain.handle('settings:load', () => ({
    config,
    distros: ['Ubuntu', 'Ubuntu-24.04', 'Debian'],
    status,
    restartRequired: false,
  }));
  ipcMain.handle('settings:save', (_event, patch) => {
    // Mirrors the real handler: the normalised value comes back to the page.
    saves.push(patch);
    if (typeof patch?.workspace === 'string' && patch.workspace.endsWith('/')) {
      config.workspace = patch.workspace.replace(/\/+$/, '');
    }
    return { ok: true, errors: [], restartRequired: false, config };
  });
}

async function windowFor(width, height, preload, file) {
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    show: true,
    frame: false,
    backgroundColor: '#0b0f16',
    webPreferences: {
      preload: join(dist, 'preload', preload),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  await window.loadURL(file.startsWith('file:') ? file : pathToFileURL(file).href);
  window.showInactive();
  return window;
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(window, script) {
  return window.webContents.executeJavaScript(script, true);
}

/** Let the preload's invoke() round-trip resolve and the DOM update. */
async function waitForText(window, selector, expected) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
    if (text.includes(expected)) return text;
    await settle(50);
  }
  return evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
}

async function capture(window, name) {
  await settle(250);
  const image = await window.webContents.capturePage();
  const file = join(scratch, name);
  writeFileSync(file, image.toPNG());
  return pathToFileURL(file).href;
}

function compose(file, body) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#0b0f16;overflow:hidden}
    img{display:block}
    .stage{position:relative;width:${WIDTH}px;height:${HEIGHT}px}
    .pop{position:absolute;right:16px;bottom:${FOOTER_HEIGHT + 6}px;width:${POPOVER.width}px;
      border-radius:8px;box-shadow:0 16px 40px rgba(0,0,0,.6)}
  </style><div class="stage">${body}</div>`;
  writeFileSync(file, html);
  return pathToFileURL(file).href;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
}

async function checkFooter() {
  const bar = await windowFor(WIDTH, FOOTER_HEIGHT, 'chrome.js', join(dist, 'chrome', 'index.html'));
  const stateLabel = await waitForText(bar, '#conn-label', 'Connected');
  check('footer renders the connection state', stateLabel.trim() === 'Connected', stateLabel);

  const endpoint = await evaluate(bar, "document.querySelector('#endpoint')?.textContent ?? ''");
  check('footer shows distro and port', endpoint === 'WSL Ubuntu :3080', endpoint);

  const tone = await evaluate(bar, "document.querySelector('#dot')?.dataset.tone ?? ''");
  check('healthy state is green', tone === 'ok', tone);

  const installed = await waitForText(bar, '#installed', '0.2.1-rc.5');
  check('footer shows the running DSH version', installed.includes('0.2.1-rc.5'), installed);

  const latest = await waitForText(bar, '#latest', '0.2.2-rc.1');
  check('footer shows the latest GitHub release', latest.includes('GitHub 0.2.2-rc.1'), latest);

  const arrow = await evaluate(bar, "!document.querySelector('#latest-arrow')?.hidden");
  check('a newer release is signalled without relying on colour', arrow === true);

  await evaluate(bar, "document.querySelector('#latest').click(), null");
  await settle(120);
  check('the release link is handed to the main process', releaseOpened === 1, String(releaseOpened));

  await evaluate(bar, "document.querySelector('#gear').click(), null");
  await settle(120);
  const expanded = await evaluate(bar, "document.querySelector('#gear').getAttribute('aria-expanded')");
  check('the gear announces the settings popover state', expanded === 'true', expanded);

  const height = await evaluate(bar, "document.querySelector('#bar').getBoundingClientRect().height");
  check('the bar is 30-34 px tall', height >= 30 && height <= 34, String(height));

  return bar;
}

async function checkPopover() {
  const popover = await windowFor(POPOVER.width, POPOVER.height, 'popover.js', join(dist, 'popover', 'index.html'));
  const groups = await evaluate(popover, "document.querySelectorAll('details.group').length");
  check('settings are grouped and collapsible', groups === 3, String(groups));

  const distroOptions = await evaluate(popover, "document.querySelectorAll('#distro option').length");
  check('the distro list is populated', distroOptions >= 3, String(distroOptions));

  const values = await evaluate(
    popover,
    `(() => {
      const v = (id) => document.getElementById(id);
      return { port: v('port').value, workspace: v('workspace').value, isolate: v('isolateEnvironment').checked };
    })()`,
  );
  check('the popover is pre-filled from the stored config', values.port === '3080', JSON.stringify(values));
  check('the workspace field shows the stored value', values.workspace === '/home/tester/projects/harness', values.workspace);
  check('the isolation toggle reflects the stored config', values.isolate === true);

  // Trailing slash: accepted by Settings, normalised before it reaches the config.
  await evaluate(
    popover,
    `(() => {
      const field = document.getElementById('workspace');
      field.value = '/home/tester/projects/harness/';
      document.getElementById('form').requestSubmit();
      return null;
    })()`,
  );
  await settle(200);
  const saved = saves.at(-1);
  check('save goes through the existing settings channel', saves.length === 1, String(saves.length));
  check('the typed value is sent unchanged for main-process validation', saved?.workspace === '/home/tester/projects/harness/');
  const notice = await evaluate(popover, "document.querySelector('#notice')?.textContent ?? ''");
  check('a successful save is reported', notice.toLowerCase().includes('saved'), notice);
  const normalised = await evaluate(popover, "document.getElementById('workspace').value");
  check('the canonical value is re-rendered after save', normalised === '/home/tester/projects/harness', normalised);

  await evaluate(popover, "document.getElementById('close').click(), null");
  await settle(120);
  check('the popover closes itself on request', popoverCloseCalls === 1, String(popoverCloseCalls));

  return popover;
}

async function writeScreenshots(bar) {
  mkdirSync(outDir, { recursive: true });
  // The checks left the gear in its expanded state; screenshots show it idle.
  await evaluate(bar, "document.querySelector('#gear').setAttribute('aria-expanded','false'), null");
  const webui = await windowFor(WIDTH, HEIGHT - FOOTER_HEIGHT, 'chrome.js', join(root, 'scripts', 'mock-webui.html'));
  const webuiUrl = await capture(webui, 'webui.png');
  const barUrl = await capture(bar, 'footer.png');
  const popover = await windowFor(POPOVER.width, POPOVER.height, 'popover.js', join(dist, 'popover', 'index.html'));
  const popoverUrl = await capture(popover, 'popover.png');

  const plain = compose(
    join(scratch, 'compose-plain.html'),
    `<img src="${webuiUrl}" width="${WIDTH}"><img src="${barUrl}" width="${WIDTH}">`,
  );
  const withPopover = compose(
    join(scratch, 'compose-popover.html'),
    `<img src="${webuiUrl}" width="${WIDTH}"><img src="${barUrl}" width="${WIDTH}"><img class="pop" src="${popoverUrl}">`,
  );

  const shot = await windowFor(WIDTH, HEIGHT, 'chrome.js', plain);
  writeFileSync(join(outDir, 'footer-bar.png'), (await shot.webContents.capturePage()).toPNG());
  const shotPopover = await windowFor(WIDTH, HEIGHT, 'chrome.js', withPopover);
  writeFileSync(join(outDir, 'footer-settings.png'), (await shotPopover.webContents.capturePage()).toPNG());
  console.log(`screenshots written to ${outDir}`);
}

async function main() {
  registerIpc();
  const bar = await checkFooter();
  await checkPopover();
  if (writeImages) await writeScreenshots(bar);
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} chrome check(s) failed`);
  }
  console.log(`chrome smoke: ok (${results.length} checks)`);
}

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    console.error(`chrome smoke failed: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    app.exit(exitCode);
  }
});
