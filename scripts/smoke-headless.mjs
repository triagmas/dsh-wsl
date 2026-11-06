#!/usr/bin/env node
/**
 * Headless launch smoke test for the Electron shell.
 *
 * It starts the real built main process under Xvfb with a sanitised environment:
 *  - PATH without the Windows interop directories, so `wsl.exe` cannot run and
 *    nothing inside a real distribution is ever touched;
 *  - HOME in a throw-away directory, so no user profile, config or log is
 *    created in the real home.
 *
 * The test asserts that the app reaches a terminal, actionable ERROR (WSL
 * missing) instead of crashing: it catches regressions like calling Electron
 * APIs before `app.whenReady()`.
 *
 * Usage: node scripts/smoke-headless.mjs   (requires dist/ and Xvfb)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronBinary = join(root, 'node_modules', 'electron', 'dist', 'electron');
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 25_000);

if (!existsSync(join(root, 'dist', 'main', 'index.js'))) {
  console.error('smoke: dist/ is missing, run `npm run build` first');
  process.exit(1);
}
if (!existsSync(electronBinary)) {
  console.error('smoke: electron binary missing, run `npm ci` first');
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'wsl-web-shell-smoke-'));
const interopDirs = [
  '/mnt/c/Windows',
  '/mnt/c/Windows/System32',
  '/mnt/c/Windows/System32/Wbem',
  '/mnt/c/Windows/System32/WindowsPowerShell/v1.0',
  '/mnt/c/Program Files',
  '/mnt/c/Program Files (x86)',
];
const basePath = (process.env.PATH ?? '')
  .split(':')
  .filter((entry) => entry !== '' && !entry.startsWith('/mnt/c/') && !interopDirs.includes(entry));

const child = spawn('xvfb-run', ['-a', electronBinary, '--no-sandbox', '.'], {
  cwd: root,
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), PATH: basePath.join(':') },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

let output = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  output += chunk;
});
child.stderr.on('data', (chunk) => {
  output += chunk;
});

const finished = new Promise((resolve) => {
  child.once('close', (code, signal) => resolve({ code, signal }));
});

/** Signal the whole process group: xvfb-run + Xvfb + electron. */
const signalGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
};

const graceTimer = setTimeout(() => signalGroup('SIGTERM'), timeoutMs);
const hardTimer = setTimeout(() => signalGroup('SIGKILL'), timeoutMs + 6_000);
const result = await Promise.race([
  finished,
  new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'timeout' }), timeoutMs + 10_000)),
]);
clearTimeout(graceTimer);
clearTimeout(hardTimer);
signalGroup('SIGKILL');

const logFile = join(home, '.config', 'wsl-web-shell', 'logs', 'app.log');
const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
if (process.env.SMOKE_KEEP !== '1') {
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Best effort only.
  }
} else {
  console.log(`smoke: kept throw-away profile at ${home}`);
}

const checks = [
  ['main process started', /wsl-web-shell .* starting/.test(log + output)],
  // The sanitised PATH hides Windows interop, so the gateway must fail closed
  // without ever reaching a real distribution.
  ['wsl.exe stays unreachable', /terminal: Windows Subsystem for Linux \(wsl\.exe\) was not found/.test(log)],
  ['no fatal bootstrap error', !/fatal startup error/.test(log + output)],
  ['no unhandled rejection', !/UnhandledPromiseRejection/.test(output)],
  ['no uncaught exception', !/\b(TypeError|ReferenceError|SyntaxError):/.test(output)],
  ['shutdown path was reachable', /quit requested|stopping owned backend/.test(log) || result.signal === 'SIGTERM'],
];

let failed = false;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok) failed = true;
}

if (failed) {
  console.error('\n--- captured output ---\n' + output.slice(-4000));
  console.error('\n--- app log ---\n' + log.slice(-4000));
  process.exit(1);
}

console.log(`smoke: ok (exit=${result.code ?? 'signal'} signal=${result.signal ?? 'none'})`);
