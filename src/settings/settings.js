/* Settings surface: app-owned configuration only, validated by the main process. */
const form = document.getElementById('form');
const distro = document.getElementById('distro');
const port = document.getElementById('port');
const workspace = document.getElementById('workspace');
const dshPath = document.getElementById('dshPath');
const autoRestart = document.getElementById('autoRestart');
const openOnLaunch = document.getElementById('openOnLaunch');
const maxRestartAttempts = document.getElementById('maxRestartAttempts');
const notice = document.getElementById('notice');
const statusLabel = document.getElementById('statusLabel');
const statusDetail = document.getElementById('statusDetail');
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

function renderStatus(status) {
  if (!status) return;
  statusLabel.textContent = STATE_LABELS[status.state] ?? status.state;
  statusDetail.textContent = status.detail ?? '';
}

async function load() {
  const snapshot = await window.settings.load();
  const config = snapshot.config;
  fillDistros(snapshot.distros, config.distro);
  port.value = String(config.port);
  workspace.value = config.workspace;
  dshPath.value = config.dshPath ?? '';
  autoRestart.checked = config.autoRestart;
  openOnLaunch.checked = config.openOnLaunch;
  maxRestartAttempts.value = String(config.maxRestartAttempts);
  renderStatus(snapshot.status);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  try {
    const result = await window.settings.save({
      distro: distro.value,
      port: Number.parseInt(port.value, 10),
      workspace: workspace.value.trim(),
      dshPath: dshPath.value.trim() === '' ? null : dshPath.value.trim(),
      autoRestart: autoRestart.checked,
      openOnLaunch: openOnLaunch.checked,
      maxRestartAttempts: Number.parseInt(maxRestartAttempts.value, 10),
    });
    if (!result.ok) {
      setNotice(result.errors.join('; '), 'error');
      return;
    }
    if (result.restartRequired) {
      setNotice('Saved. Restart the WebUI from the tray menu to apply backend changes.', 'ok');
    } else {
      setNotice('Saved.', 'ok');
    }
  } finally {
    saveButton.disabled = false;
  }
});

document.getElementById('cancel').addEventListener('click', () => window.settings.close());
document.getElementById('openConfig').addEventListener('click', () => window.settings.openConfigFolder());

window.settings.onStatus(renderStatus);
load().catch((error) => setNotice(String(error?.message ?? error), 'error'));
