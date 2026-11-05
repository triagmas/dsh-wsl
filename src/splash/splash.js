/* Splash / reconnect overlay controller. Plain DOM, no framework. */
const shell = document.getElementById('shell');
const stage = document.getElementById('stage');
const detail = document.getElementById('detail');
const actions = document.getElementById('actions');
const meta = document.getElementById('meta');
const retryButton = document.getElementById('retry');
const logsButton = document.getElementById('logs');

function render(status) {
  if (!status) return;
  shell.dataset.state = status.state;
  stage.textContent = status.message;
  if (status.detail) {
    detail.hidden = false;
    detail.textContent = status.detail;
  } else {
    detail.hidden = true;
    detail.textContent = '';
  }
  actions.hidden = status.state !== 'ERROR';
  const parts = [status.distro, `port ${status.port}`];
  if (status.attempt > 0) parts.push(`attempt ${status.attempt}/${status.maxAttempts}`);
  meta.textContent = parts.join(' · ');
}

retryButton.addEventListener('click', () => {
  retryButton.disabled = true;
  window.shell?.retry().finally(() => {
    retryButton.disabled = false;
  });
});

logsButton.addEventListener('click', () => {
  window.shell?.openLogs();
});

window.shell?.onStatus(render);
window.shell?.requestStatus().then(render).catch(() => undefined);
