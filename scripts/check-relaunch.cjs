#!/usr/bin/env node
/*
 * Packaged relaunch check (issues #12 and #14).
 *
 * Reads the markers written by `--relaunch-probe` in a packaged Windows build and
 * proves that the relaunch target was the executable the user actually started,
 * for both shipped packages:
 *
 *   --mode=portable  the target must be the portable EXE, not the temporary
 *                    extraction directory Electron runs from
 *   --mode=installed the target must be the installed `process.execPath`, and the
 *                    child must run from that same installation
 *
 * Note on what the portable child reports: a portable build always starts from a
 * fresh extraction directory, so `child.execPath` is *not* the portable EXE —
 * that is exactly why relaunching `process.execPath` is wrong. The portable
 * launcher re-establishes the origin, so the discriminating check is that the
 * child still reports `PORTABLE_EXECUTABLE_FILE` as the portable EXE. An
 * installed build has no portable origin at all and keeps its `execPath`.
 *
 *   node scripts/check-relaunch.cjs <marker-dir> <exe> [timeout-seconds] [--mode=portable|installed]
 *
 * Exits non-zero when the child never started, when it started from another
 * executable, or when the recorded decision did not match the expected package.
 */
'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--mode'));
const modeArgument = process.argv.slice(2).find((argument) => argument.startsWith('--mode'));
const mode = modeArgument === undefined ? 'portable' : modeArgument.slice('--mode'.length).replace(/^=/, '');
if (mode !== 'portable' && mode !== 'installed') {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}

const [directory, targetArg, timeoutArg] = positional;
if (directory === undefined || targetArg === undefined) {
  console.error('usage: check-relaunch.cjs <marker-dir> <exe> [timeout-seconds] [--mode=portable|installed]');
  process.exit(2);
}

const target = resolve(targetArg);
const timeoutMs = (Number.parseInt(timeoutArg ?? '120', 10) || 120) * 1000;
const read = (name) => {
  const file = join(directory, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const samePath = (left, right) =>
  typeof left === 'string' && resolve(left).toLowerCase() === resolve(right).toLowerCase();

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
};

const deadline = Date.now() + timeoutMs;
let parent = read('parent.json');
while (parent === null && Date.now() < deadline) {
  // The parent writes its marker immediately; a missing one means it never ran.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  parent = read('parent.json');
}

const portableMode = mode === 'portable';

if (parent === null) {
  check('the packaged EXE starts and records its own path', false, 'parent.json is missing');
} else if (portableMode) {
  check('the packaged EXE starts and records its own path', true);
  check('the running build reports the portable EXE as its origin', samePath(parent.portable, target), String(parent.portable));
  const decision = read('decision.json');
  check('the relaunch decision targets the portable EXE', decision?.ok === true && decision?.target?.portable === true, JSON.stringify(decision));
  check(
    'the relaunch target is the file the user started',
    decision?.ok === true && samePath(decision?.target?.execPath, target),
    JSON.stringify(decision?.target),
  );
} else {
  check('the installed EXE starts and records its own path', true);
  check('the running build reports no portable origin', parent.portable === null, String(parent.portable));
  check('the running build is a packaged installation', parent.packaged === true, String(parent.packaged));
  check(
    'it runs from the installation it was started from',
    samePath(parent.execPath, target),
    String(parent.execPath),
  );
  const decision = read('decision.json');
  check(
    'the relaunch decision targets the installed EXE',
    decision?.ok === true && decision?.target?.mode === 'installed' && decision?.target?.portable === false,
    JSON.stringify(decision),
  );
  check(
    'the relaunch target is the installed file',
    decision?.ok === true && samePath(decision?.target?.execPath, target),
    JSON.stringify(decision?.target),
  );
}

let child = read('child.json');
while (child === null && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  child = read('child.json');
}

if (child === null) {
  check('the relaunched instance starts', false, 'child.json is missing');
} else {
  check('the relaunched instance starts', true);
  check('it is a new process, not the probe that relaunched it', child.pid !== parent?.pid, `${child.pid} vs ${parent?.pid}`);
  if (portableMode) {
    // The portable launcher re-extracts and starts the inner copy, so `execPath`
    // is a temp path by design; a child started from the inner copy directly would
    // have no portable origin at all.
    check(
      'it was started by the portable EXE, not by the inner extraction copy',
      samePath(child.portable, target),
      `portable=${String(child.portable)} execPath=${String(child.execPath)}`,
    );
  } else {
    // An installed build runs in place: the child must come from the same
    // installation directory and must not be a temporary extraction copy.
    check(
      'it was started from the installed EXE',
      child.portable === null && samePath(child.execPath, target),
      `portable=${String(child.portable)} execPath=${String(child.execPath)}`,
    );
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`relaunch check (${mode}): ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
