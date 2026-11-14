'use strict';

/**
 * Manual update window (issue #12 follow-up).
 *
 * The main process did the read-only inspection; this page only renders it and
 * lets the owner copy the commands. It never asks for a password and never starts
 * a process: the update itself happens in the owner's WSL terminal.
 */
const installedEl = document.getElementById('installed');
const targetEl = document.getElementById('target');
const distroEl = document.getElementById('distro');
const binaryEl = document.getElementById('binary');
const scopeEl = document.getElementById('scope');
const statusEl = document.getElementById('status');
const descriptionEl = document.getElementById('description');
const commandsEl = document.getElementById('commands');
const commandListEl = document.getElementById('command-list');
const copyAllButton = document.getElementById('copy-all');
const copiedEl = document.getElementById('copied');
const recheckButton = document.getElementById('recheck');
const closeButton = document.getElementById('close');

let commands = [];
let copyStatusTimer = null;

/** Copies text without relying on a secure context or a permission prompt. */
async function copyText(text) {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the selection-based copy.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

function announce(message) {
  copiedEl.textContent = message;
  if (copyStatusTimer !== null) clearTimeout(copyStatusTimer);
  copyStatusTimer = setTimeout(() => {
    copiedEl.textContent = '';
    copyStatusTimer = null;
  }, 2_000);
}

async function copy(text) {
  announce((await copyText(text)) ? 'Copied.' : 'Copy failed; select the line and copy it manually.');
}

function renderCommand(command, index) {
  const row = document.createElement('li');
  row.className = 'command';
  const code = document.createElement('code');
  code.textContent = command;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary small';
  button.textContent = 'Copy';
  button.addEventListener('click', () => {
    void copy(commands[index] ?? command);
  });
  row.append(code, button);
  return row;
}

function render(probe) {
  installedEl.textContent = probe.installed ?? 'unknown';
  targetEl.textContent = probe.target ?? 'unknown';
  distroEl.textContent = probe.distro;
  binaryEl.textContent = probe.dshPath ?? 'not found';
  scopeEl.textContent =
    probe.installManager === 'npm' || probe.installManager === 'pnpm'
      ? `${probe.installManager}, global ${probe.installScope}`
      : probe.installManager;

  commands = Array.isArray(probe.commands) ? probe.commands.filter((line) => typeof line === 'string' && line !== '') : [];
  commandListEl.replaceChildren(...commands.map(renderCommand));
  commandsEl.hidden = commands.length === 0;
  copyAllButton.hidden = commands.length === 0;

  descriptionEl.hidden = probe.description === null || probe.description === '';
  descriptionEl.textContent = probe.description ?? '';

  if (probe.state === 'installed') {
    statusEl.dataset.state = 'installed';
    statusEl.textContent = 'The installed version is current.';
  } else if (probe.state === 'pending') {
    statusEl.dataset.state = 'pending';
    statusEl.textContent =
      commands.length === 0 ? 'A newer version exists, but no command can be shown.' : 'A newer version is available.';
  } else {
    statusEl.dataset.state = 'unknown';
    statusEl.textContent = 'The installed and published versions cannot be compared.';
  }
}

async function load(useRecheck) {
  recheckButton.disabled = true;
  statusEl.dataset.state = 'checking';
  statusEl.textContent = 'Checking the installation…';
  try {
    const bridge = window.update;
    if (bridge === undefined) throw new Error('no update bridge');
    const probe = useRecheck ? await bridge.recheck() : await bridge.probe();
    render(probe);
  } catch {
    statusEl.dataset.state = 'unknown';
    statusEl.textContent = 'The update details are not available.';
    descriptionEl.hidden = true;
    commandsEl.hidden = true;
  } finally {
    recheckButton.disabled = false;
  }
}

copyAllButton.addEventListener('click', () => {
  if (commands.length > 0) void copy(commands.join('\n'));
});

recheckButton.addEventListener('click', () => {
  void load(true);
});

closeButton.addEventListener('click', () => {
  void window.update?.close();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void window.update?.close();
});

void load(false);
