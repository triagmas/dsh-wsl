'use strict';

/**
 * Confirmation window (issue #12).
 *
 * Renders the snapshot the main process validated. The Update button is only
 * enabled when the plan was accepted, so the window cannot start something the
 * safety checks rejected.
 */
const installedEl = document.getElementById('installed');
const targetEl = document.getElementById('target');
const distroEl = document.getElementById('distro');
const binaryEl = document.getElementById('binary');
const scopeEl = document.getElementById('scope');
const blockedEl = document.getElementById('blocked');
const manualEl = document.getElementById('manual');
const startButton = document.getElementById('start');
const cancelButton = document.getElementById('cancel');

function render(probe) {
  installedEl.textContent = probe.installed ?? 'unknown';
  targetEl.textContent = probe.target ?? 'unknown';
  distroEl.textContent = probe.distro;
  binaryEl.textContent = probe.dshPath ?? 'not found';
  scopeEl.textContent =
    probe.installManager === 'npm'
      ? `npm, global ${probe.installScope}`
      : `${probe.installManager} (not updateable from the app)`;
  if (probe.eligible) {
    blockedEl.hidden = true;
    startButton.disabled = false;
  } else {
    blockedEl.hidden = false;
    blockedEl.textContent = probe.description ?? 'This update cannot be started safely.';
    startButton.disabled = true;
  }
  if (probe.manualCommand !== null) {
    manualEl.hidden = false;
    manualEl.textContent = `To update it yourself, run inside WSL: ${probe.manualCommand}`;
  } else {
    manualEl.hidden = true;
    manualEl.textContent = '';
  }
  if (probe.running) {
    blockedEl.hidden = false;
    blockedEl.textContent = 'An update is already running.';
    startButton.disabled = true;
  }
}

// --- one-password rule install -----------------------------------------
const ruleSection = document.getElementById('rule');
const ruleUnitEl = document.getElementById('rule-unit');
const ruleLineEl = document.getElementById('rule-line');
const ruleUserEl = document.getElementById('rule-user');
const rulePassEl = document.getElementById('rule-pass');
const ruleErrorEl = document.getElementById('rule-error');
const ruleInstallButton = document.getElementById('rule-install');
const ruleCancelButton = document.getElementById('rule-cancel');

function showRule(hint) {
  ruleSection.hidden = false;
  ruleUnitEl.textContent = hint.unit;
  ruleLineEl.textContent = hint.line;
  ruleUserEl.textContent = hint.user;
  ruleErrorEl.hidden = true;
  ruleErrorEl.textContent = '';
  startButton.disabled = true;
  ruleInstallButton.disabled = false;
  rulePassEl.value = '';
  rulePassEl.focus();
}

function hideRule() {
  ruleSection.hidden = true;
  // The value never stays in the DOM after it was used or abandoned.
  rulePassEl.value = '';
}

/** Asks for the password once, then starts the update that was refused for it. */
function installRuleAndStart() {
  const password = rulePassEl.value;
  if (password.length === 0) {
    ruleErrorEl.hidden = false;
    ruleErrorEl.textContent = 'Type the password for this WSL user.';
    return;
  }
  ruleInstallButton.disabled = true;
  rulePassEl.value = '';
  window.update
    ?.installRule(password)
    .then((result) => {
      if (result.ok === true) {
        hideRule();
        startButton.click();
        return;
      }
      ruleErrorEl.hidden = false;
      ruleErrorEl.textContent =
        result.message === null
          ? 'The password was rejected; nothing was changed.'
          : `The rule was not installed: ${result.message}`;
      ruleInstallButton.disabled = false;
    })
    .catch(() => {
      ruleErrorEl.hidden = false;
      ruleErrorEl.textContent = 'The rule could not be installed.';
      ruleInstallButton.disabled = false;
    });
}

ruleInstallButton.addEventListener('click', installRuleAndStart);
rulePassEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    installRuleAndStart();
  }
});
ruleCancelButton.addEventListener('click', () => {
  hideRule();
  startButton.disabled = false;
});

startButton.addEventListener('click', () => {
  startButton.disabled = true;
  window.update
    ?.start()
    .then((result) => {
      if (result.started === true) return;
      if (result.reason === 'rule-needed' && result.rule) {
        // Not a dead end: one password turns the refusal into a working update.
        blockedEl.hidden = true;
        showRule(result.rule);
        return;
      }
      blockedEl.hidden = false;
      blockedEl.textContent = result.description ?? 'The update could not be started.';
      startButton.disabled = false;
    })
    .catch(() => {
      blockedEl.hidden = false;
      blockedEl.textContent = 'The update could not be started.';
      startButton.disabled = false;
    });
});

cancelButton.addEventListener('click', () => {
  window.update?.close();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.update?.close();
});

window.update
  ?.probe()
  .then(render)
  .catch(() => {
    blockedEl.hidden = false;
    blockedEl.textContent = 'Update details are not available.';
    startButton.disabled = true;
  });
