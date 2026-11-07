'use strict';

/**
 * Terminal modal (issue #12).
 *
 * Shows the updater output line by line, keeps the last state when the window is
 * opened late, and only offers Close once the run finished. The text is set with
 * `textContent` — never parsed as markup.
 */
const headingEl = document.getElementById('heading');
const statusEl = document.getElementById('status');
const terminalEl = document.getElementById('terminal');
const detailEl = document.getElementById('detail');
const closeButton = document.getElementById('close');

let rendered = 0;

function appendLines(lines) {
  if (lines.length < rendered) {
    // Buffer was replaced (new run): rebuild from scratch.
    terminalEl.textContent = '';
    rendered = 0;
  }
  const fragment = lines.slice(rendered);
  if (fragment.length === 0) return;
  terminalEl.appendChild(document.createTextNode(`${fragment.join('\n')}\n`));
  rendered = lines.length;
  terminalEl.scrollTop = terminalEl.scrollHeight;
}

function render(state) {
  if (!state) return;
  statusEl.textContent = state.message;
  statusEl.dataset.phase = state.phase;
  // The heading names the situation, the status line carries the detail, so the
  // window never shows the same sentence twice.
  headingEl.textContent =
    state.phase === 'done'
      ? 'Update finished'
      : state.phase === 'failed'
        ? 'Update failed'
        : `Updating DeepSeek Harness to ${state.targetVersion ?? '…'}`;
  detailEl.hidden = state.detail === null || state.detail === '';
  detailEl.textContent = state.detail ?? '';
  appendLines(Array.isArray(state.lines) ? state.lines : []);
  const finished = state.phase === 'done' || state.phase === 'failed' || state.phase === 'idle';
  closeButton.disabled = !finished;
  closeButton.textContent = state.phase === 'done' ? 'Close' : 'Close';
}

closeButton.addEventListener('click', () => {
  window.update?.close();
});

window.update?.onState(render);
window.update
  ?.state()
  .then(render)
  .catch(() => {
    statusEl.textContent = 'Update state is not available.';
    closeButton.disabled = false;
  });

// Guard against a stuck window: never let the modal become unclosable.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !closeButton.disabled) window.update?.close();
});
