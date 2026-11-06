/*
 * Settings popover controller.
 *
 * Every value is validated by the main process (`settings:save` → applyConfigPatch),
 * exactly like the full settings window; this page only collects the fields and
 * renders the result. Nothing here keeps its own copy of the configuration.
 */
const form = document.getElementById('form');
const distro = document.getElementById('distro');
const port = document.getElementById('port');
const workspace = document.getElementById('workspace');
const dshPath = document.getElementById('dshPath');
const isolateEnvironment = document.getElementById('isolateEnvironment');
const runtimeRoot = document.getElementById('runtimeRoot');
const autoRestart = document.getElementById('autoRestart');
const maxRestartAttempts = document.getElementById('maxRestartAttempts');
const openOnLaunch = document.getElementById('openOnLaunch');
const notice = document.getElementById('notice');
const stateLabel = document.getElementById('stateLabel');
const saveButton = document.getElementById('save');

const STATE_LABELS = {
  CHECKING: 'Checking',
  STARTING_WSL: 'Starting WSL',
  STARTING_WEB: 'Starting backend',
  CONNECTING: 'Connecting',
  READY: 'Connected',
  HIDDEN_IN_TRAY: 'Connected (hidden)',
  RECOVERING: 'Reconnecting',
  ERROR: 'Unavailable',
  QUITTING: 'Shutting down',
};

function setNotice(text, kind) {
  notice.textContent = text || '';
  notice.className = `notice${kind ? ` ${kind}` : ''}`;
}

function renderStatus(status) {
  if (!status) return;
  stateLabel.textContent = `${STATE_LABELS[status.state] ?? status.state} · ${status.distro} :${status.port}`;
  stateLabel.title = status.detail ?? '';
}

function fillDistros(distros, current) {
  distro.innerHTML = '';
  const names = distros.includes(current) ? distros : [current, ...distros];
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    distro.append(option);
  }
  distro.value = current;
}

async function load() {
  const snapshot = await window.popover.load();
  const config = snapshot.config;
  fillDistros(snapshot.distros, config.distro);
  port.value = String(config.port);
  workspace.value = config.workspace;
  dshPath.value = config.dshPath ?? '';
  isolateEnvironment.checked = config.isolateEnvironment;
  runtimeRoot.value = config.runtimeRoot;
  runtimeRoot.disabled = !config.isolateEnvironment;
  autoRestart.checked = config.autoRestart;
  openOnLaunch.checked = config.openOnLaunch;
  maxRestartAttempts.value = String(config.maxRestartAttempts);
  renderStatus(snapshot.status);
}

isolateEnvironment.addEventListener('change', () => {
  runtimeRoot.disabled = !isolateEnvironment.checked;
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const result = await window.popover.save({
      distro: distro.value,
      port: Number.parseInt(port.value, 10),
      workspace: workspace.value.trim(),
      dshPath: dshPath.value.trim() === '' ? null : dshPath.value.trim(),
      isolateEnvironment: isolateEnvironment.checked,
      runtimeRoot: runtimeRoot.value.trim(),
      autoRestart: autoRestart.checked,
      openOnLaunch: openOnLaunch.checked,
      maxRestartAttempts: Number.parseInt(maxRestartAttempts.value, 10),
    });
    if (!result.ok) {
      setNotice(result.errors.join('; '), 'error');
      return;
    }
    if (result.restartRequired) {
      setNotice('Saved. Restart the WebUI from the tray to apply backend changes.', 'ok');
    } else {
      setNotice('Saved.', 'ok');
    }
    // Reflect the canonical value (normalisation) and the fresh status.
    await load();
  } finally {
    saveButton.disabled = false;
  }
});

document.getElementById('close').addEventListener('click', () => window.popover.close());
document.getElementById('openFull').addEventListener('click', () => window.popover.openFullSettings());

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.popover.close();
  }
});

window.popover.onStatus(renderStatus);
load().catch((error) => setNotice(String(error?.message ?? error), 'error'));
