/** Real `wsl.exe` gateway used by the Electron main process. */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  WslGateway,
  ServerHandle,
  StartServerRequest,
  ExitInfo,
  InspectSharedRequest,
} from '../core/supervisor.js';
import { parseSharedDshReport } from '../core/dsh-locate.js';
import { ShellError } from '../core/supervisor.js';
import type { Logger } from '../core/logger.js';
import type { ProcessProbe } from './output.js';
import { parseDshVersion } from '../core/versions.js';
import { describeError } from '../core/diagnostics.js';
import {
  decodeWslOutput,
  LineBuffer,
  parseDistroList,
  parsePidMarker,
  parseProcessProbe,
  parseRuntimeProbe,
  stripAnsi,
} from './output.js';
import {
  WSL_EXE,
  buildDistroProbeArgs,
  buildDshPathCheckArgs,
  buildDshVersionArgs,
  buildListDistrosArgs,
  buildPrepareIsolationArgs,
  buildFindKeepaliveArgs,
  buildFindPortOwnerArgs,
  buildKeepaliveArgs,
  buildProbeProcessArgs,
  buildResolveRuntimeArgs,
  buildSignalArgs,
  buildStartServerArgs,
} from './args.js';
import { buildInspectArgs } from './inspect.js';
import { buildProbeManagedArgs, parseManagedReport, type ManagedBackend } from './managed.js';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface WslGatewayOptions {
  log: Logger;
  wslExe?: string;
  spawnImpl?: typeof spawn;
  /**
   * How long a killed WSL command gets to report its own exit; tests lower it so
   * the timeout path does not wait the production grace period.
   */
  timeouts?: {
    terminationGraceMs?: number;
    /** How long a keepalive must stay alive before it is reported as working. */
    keepaliveAliveMs?: number;
  };
}

/** Budget for reading the cgroup of the backend the app is attached to. */
const MANAGED_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a killed WSL command to report its own exit.
 *
 * A timeout is not proof that the Linux side is gone, so the app keeps waiting
 * for `close` instead of assuming the process stopped.
 */
const TERMINATION_GRACE_MS = 15_000;

/**
 * How long a new keepalive must survive before it counts as started.
 *
 * `exit` arrives asynchronously, so returning the pid immediately would let the
 * supervisor log "the distribution is kept open" for a session that is already
 * gone.
 */
const KEEPALIVE_ALIVE_MS = 750;

/** Did the child survive its first moments, or exit (or fail to start) instead? */
function staysAlive(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(false);
      return;
    }
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(true);
    }, ms);
    child.once('exit', onExit);
  });
}

export function createWslGateway(options: WslGatewayOptions): WslGateway {
  const wslExe = options.wslExe ?? WSL_EXE;
  const spawnImpl = options.spawnImpl ?? spawn;
  const terminationGraceMs = options.timeouts?.terminationGraceMs ?? TERMINATION_GRACE_MS;
  const keepaliveAliveMs = options.timeouts?.keepaliveAliveMs ?? KEEPALIVE_ALIVE_MS;

  const run = (args: string[], timeoutMs: number): Promise<CommandResult> =>
    new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnImpl(wslExe, args, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        }) as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(error);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      let timedOut = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => {
        if (settled) return;
        // The budget expired: kill and then wait for the process to report its own
        // exit, so a caller can tell "gone" from "still running" (review R02).
        timedOut = true;
        try {
          child.kill();
        } catch {
          // A failing kill is not an exit either; the grace timer below decides.
        }
        graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(
            new ShellError(
              'unexpected',
              'A WSL command timed out and did not confirm its exit.',
              'The distribution may be unresponsive. The process was not confirmed to have stopped.',
            ),
          );
        }, terminationGraceMs);
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (error.code === 'ENOENT') {
          reject(
            new ShellError(
              'wsl-missing',
              'Windows Subsystem for Linux (wsl.exe) was not found.',
              'Install WSL with "wsl --install" and restart Windows, then relaunch this app.',
            ),
          );
          return;
        }
        reject(error);
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        if (timedOut) {
          reject(
            new ShellError('unexpected', 'A WSL command timed out.', 'The distribution may be unresponsive.'),
          );
          return;
        }
        resolve({
          code,
          stdout: stripAnsi(decodeWslOutput(Buffer.concat(stdoutChunks))),
          stderr: stripAnsi(decodeWslOutput(Buffer.concat(stderrChunks))),
        });
      });
    });

  const ensureSuccess = (result: CommandResult, message: string): CommandResult => {
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ');
      throw new ShellError('unexpected', message, detail === '' ? null : detail);
    }
    return result;
  };

  return {
    async listDistros() {
      const result = await run(buildListDistrosArgs(), 30_000);
      if (result.code !== 0) {
        throw new ShellError(
          'wsl-missing',
          'WSL did not report any distributions.',
          (result.stderr || result.stdout).trim() || 'Run "wsl --install" and try again.',
        );
      }
      return parseDistroList(result.stdout);
    },

    async ensureDistro(distro) {
      try {
        ensureSuccess(await run(buildDistroProbeArgs(distro), 60_000), `Could not start the WSL distribution "${distro}".`);
      } catch (error) {
        if (error instanceof ShellError && error.code === 'unexpected') {
          throw new ShellError(
            'distro-missing',
            `Could not start the WSL distribution "${distro}".`,
            error.hint ?? 'Open the distribution once in Windows Terminal and try again.',
          );
        }
        throw error;
      }
      options.log.info(`wsl distribution ready: ${distro}`);
    },

    async prepareIsolation(distro, root) {
      const result = await run(buildPrepareIsolationArgs(distro, root), 30_000);
      if (result.code !== 0) {
        throw new ShellError(
          'unexpected',
          'The isolated backend environment could not be created inside WSL.',
          (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ') || 'Check permissions of the runtime root in Settings.',
        );
      }
      options.log.info(`isolated environment ready: ${result.stdout.trim().split('\n').pop() ?? root}`);
    },

    async resolveRuntime(distro, override, isolationRoot) {
      const result = await run(buildResolveRuntimeArgs(distro, isolationRoot, override), 30_000);
      const probe = parseRuntimeProbe(result.stdout);
      if (probe.nodePath !== null) options.log.info(`node runtime: ${probe.nodePath}`);
      if (probe.legacyRuntimePresent) {
        options.log.info('an older private runtime/bin exists in the isolated root; it is not used any more');
      }

      if (override !== null) {
        const check = await run(buildDshPathCheckArgs(distro, override), 20_000);
        if (check.code === 0) {
          options.log.info(`dsh (configured): ${override}`);
          return {
            dshPath: override,
            nodePath: probe.nodePath,
            canonicalRoot: probe.rootPath,
            source: 'custom',
            legacyRuntimePresent: probe.legacyRuntimePresent,
          };
        }
        throw new ShellError(
          'dsh-missing',
          `The configured DeepSeek Harness path is not executable: ${override}`,
          'Update the path in Settings, or clear it to use the installation your WSL terminal uses.',
        );
      }

      if (probe.dshPath === null) {
        throw new ShellError(
          'dsh-missing',
          'DeepSeek Harness CLI (dsh) was not found inside the WSL distribution.',
          'Install it in that distribution the usual way (for example "npm install -g @deepseek-ai/dsh"), or set its absolute path in Settings. DSH WSL runs the installation that already exists and never installs a private copy.',
        );
      }
      const check = await run(buildDshPathCheckArgs(distro, probe.dshPath), 20_000);
      if (check.code !== 0) {
        throw new ShellError('dsh-missing', 'The detected DeepSeek Harness CLI is not executable.', 'Set the executable path in Settings.');
      }
      options.log.info(`dsh resolved: ${probe.dshPath} (source=${probe.source ?? 'unknown'})`);
      if (probe.rootPath !== null) options.log.info(`isolated data root (canonical): ${probe.rootPath}`);
      return {
        dshPath: probe.dshPath,
        nodePath: probe.nodePath,
        canonicalRoot: probe.rootPath,
        source: probe.source,
        legacyRuntimePresent: probe.legacyRuntimePresent,
      };
    },

    startServer(request: StartServerRequest): ServerHandle {
      const argv = buildStartServerArgs(request);
      options.log.info(`starting backend: ${argv.slice(0, 4).join(' ')} (port=${request.port})`);
      const child = spawnImpl(wslExe, argv, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, WSL_UTF8: '1' },
      }) as unknown as ChildProcessWithoutNullStreams;

      const collected: string[] = [];
      const listeners = new Set<(line: string) => void>();
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      let stderrTail = '';
      let resolvePid: (pid: number | null) => void = () => undefined;
      const pidPromise = new Promise<number | null>((resolve) => {
        resolvePid = resolve;
      });
      let pidSettled = false;

      const emit = (line: string): void => {
        if (line === '') return;
        collected.push(line);
        if (collected.length > 2000) collected.splice(0, collected.length - 2000);
        if (!pidSettled) {
          const marker = parsePidMarker(line);
          if (marker !== null) {
            pidSettled = true;
            resolvePid(marker);
          }
        }
        for (const listener of listeners) listener(line);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of stdoutBuffer.push(chunk)) emit(stripAnsi(line));
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrTail = `${stderrTail}${stripAnsi(chunk)}`.slice(-4000);
        for (const line of stderrBuffer.push(chunk)) emit(`[stderr] ${stripAnsi(line)}`);
      });

      const exited = new Promise<ExitInfo>((resolve) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          if (!pidSettled) {
            pidSettled = true;
            resolvePid(null);
          }
          options.log.error(`backend spawn failed: ${error.code ?? error.message}`);
          resolve({ code: null, signal: null });
        });
        child.once('close', (code, signal) => {
          if (!pidSettled) {
            pidSettled = true;
            resolvePid(null);
          }
          for (const line of stdoutBuffer.flush()) emit(stripAnsi(line));
          for (const line of stderrBuffer.flush()) emit(`[stderr] ${stripAnsi(line)}`);
          resolve({ code: code ?? null, signal: signal ?? null });
        });
      });

      return {
        pid: pidPromise,
        lines: () => [...collected],
        onLine(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        exited,
        async stop() {
          if (child.exitCode !== null || child.signalCode !== null) return;
          child.kill();
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
        },
        stderrTail: () => stderrTail,
      };
    },

    async probeManagedBackend(request: { distro: string; pid: number }): Promise<ManagedBackend> {
      const result = await run(buildProbeManagedArgs(request), MANAGED_TIMEOUT_MS);
      const managed = parseManagedReport(`${result.stdout}\n${result.stderr}`);
      if (result.code !== 0) {
        options.log.warn(`the backend manager could not be identified (code=${result.code ?? 'null'})`);
        // Not identifying the manager is not the same as "no manager": treat it as
        // one more obstacle the owner has to remove by hand (`scope: 'none'`).
        return managed;
      }
      if (managed.scope === 'none') {
        options.log.info('the attached backend was not started by a systemd unit');
      } else {
        options.log.info(`the attached backend belongs to ${managed.unit} (${managed.scope} scope)`);
      }
      return managed;
    },

    async inspectSharedDsh(request: InspectSharedRequest) {
      const result = await run(
        buildInspectArgs({
          distro: request.distro,
          appRoot: request.appRoot,
          dshPath: request.dshPath,
          nodePath: request.nodePath,
          ownPid: request.ownPid,
        }),
        45_000,
      );
      const report = parseSharedDshReport(`${result.stdout}\n${result.stderr}`);
      if (result.code !== 0) {
        options.log.warn(`DeepSeek Harness inspection failed (code=${result.code ?? 'null'})`);
      }
      if (report.installation !== null) {
        options.log.info(
          `dsh installation: ${report.installation.path} (${report.installation.version ?? 'unknown'}, ` +
            `${report.installation.manager}, prefix=${report.installation.prefix ?? 'unknown'}, ` +
            `writable=${report.installation.writable ? 'yes' : 'no'})`,
        );
      }
      return report;
    },

    async dshVersion(distro: string, dshPath: string, nodePath: string | null = null): Promise<string | null> {
      const result = await run(buildDshVersionArgs(distro, dshPath, nodePath), 15_000);
      if (result.code !== 0) {
        options.log.warn(`dsh --version did not report a version (code=${result.code ?? 'null'})`);
        // One stderr line is enough to tell a missing runtime from a bad CLI.
        const tail = (result.stderr || result.stdout).trim().split('\n').pop();
        if (tail !== undefined && tail !== '') options.log.debug(`dsh --version output: ${tail}`);
        return null;
      }
      const parsed = parseDshVersion(`${result.stdout}\n${result.stderr}`);
      if (parsed === null) options.log.warn('dsh --version output was not recognised');
      return parsed;
    },

    async probeProcess(distro: string, pid: number): Promise<ProcessProbe | null> {
      const result = await run(buildProbeProcessArgs(distro, pid), 10_000);
      if (result.code !== 0) return null;
      return parseProcessProbe(result.stdout);
    },

    async findPortOwner(distro: string, port: number, nodePath: string | null): Promise<number | null> {
      if (nodePath === null) return null;
      let args: string[];
      try {
        args = buildFindPortOwnerArgs(distro, nodePath, port);
      } catch {
        // An unusable node path is not a listener fact; the caller keeps its
        // normal collision handling.
        return null;
      }
      const result = await run(args, 10_000);
      if (result.code !== 0) return null;
      const pid = Number(result.stdout.trim());
      return Number.isInteger(pid) && pid > 1 ? pid : null;
    },

    async ensureKeepalive(distro: string, nodePath: string | null): Promise<number | null> {
      if (nodePath !== null) {
        try {
          const found = await run(buildFindKeepaliveArgs(distro, nodePath), 10_000);
          const pid = Number(found.stdout.trim());
          if (found.code === 0 && Number.isInteger(pid) && pid > 1) {
            options.log.debug(`distribution keepalive already running (pid=${pid})`);
            return pid;
          }
        } catch {
          // An unusable runtime must not stop the keepalive: the session below
          // is the part that matters, and a duplicate one is harmless.
        }
      }
      try {
        const child = spawnImpl(wslExe, buildKeepaliveArgs(distro), {
          windowsHide: true,
          stdio: 'ignore',
        });
        // Deliberately not `detached`. On Windows `detached` maps to
        // DETACHED_PROCESS, which defeats CREATE_NO_WINDOW: the console program
        // then allocates its own console and the default terminal application
        // opens a visible window for it. The owner closed exactly that window on
        // 2026-11-14, which killed the only client holding the distribution open;
        // WSL2 powered the distro off ten seconds later and took the backend, and
        // the WebUI session with it. A child outlives this process without
        // `detached`; `unref()` is what keeps it out of our event loop.
        //
        // A failed creation (a missing wsl.exe, for example) arrives as an
        // asynchronous `error` event. Without a listener Node treats it as an
        // uncaught exception, and the app's fatal handler would exit over a
        // best-effort keepalive.
        child.on('error', (error: unknown) => {
          options.log.warn(`could not hold the distribution open: ${describeError(error)}`);
        });
        child.unref();
        const pid = child.pid ?? null;
        if (pid === null) {
          options.log.warn('could not hold the distribution open: wsl.exe reported no process id');
          return null;
        }
        if (!(await staysAlive(child, keepaliveAliveMs))) {
          options.log.warn('the distribution keepalive exited immediately; the backend may be powered off');
          return null;
        }
        child.on('exit', (code, signal) => {
          options.log.warn(
            `the distribution keepalive exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}); ` +
              'WSL2 powers a distribution off about ten seconds after its last client exits',
          );
        });
        options.log.info('holding the WSL distribution open while its backend runs outside the app');
        return pid;
      } catch (error) {
        options.log.warn(`could not hold the distribution open: ${describeError(error)}`);
        return null;
      }
    },

    async signal(distro, pid, signal) {
      const result = await run(buildSignalArgs(distro, pid, signal), 10_000);
      if (result.code !== 0) {
        options.log.warn(`signal ${signal} to pid ${pid} was not delivered (code=${result.code ?? 'null'})`);
      }
    },
  };
}
