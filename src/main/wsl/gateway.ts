/** Real `wsl.exe` gateway used by the Electron main process. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  WslGateway,
  ServerHandle,
  StartServerRequest,
  ExitInfo,
  UpdateRunResult,
  SharedUpdateRunRequest,
  SharedRollbackRequest,
  InspectSharedRequest,
  PrepareBackupRequest,
} from '../core/supervisor.js';
import { parseSharedDshReport } from '../core/dsh-locate.js';
import { ShellError } from '../core/supervisor.js';
import type { Logger } from '../core/logger.js';
import type { ProcessProbe } from './output.js';
import { parseDshVersion } from '../core/versions.js';
import { backupFailureDetail } from '../core/update.js';
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
  buildProbeProcessArgs,
  buildResolveRuntimeArgs,
  buildSignalArgs,
  buildStartServerArgs,
} from './args.js';
import {
  buildCleanSnapshotArgs,
  buildInspectSharedArgs,
  buildNpmViewArgs,
  buildPrepareBackupArgs,
  buildRollbackSharedArgs,
  buildUpdateSharedArgs,
  NPM_MARKER,
  parseBackupReport,
  parseCleanSnapshotReport,
  parseNpmMarker,
  type CleanSnapshotReport,
} from './update-args.js';

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
   * Overrides for the two snapshot-stage budgets, used by tests only.
   *
   * The defaults are the measured budgets below; a test that must observe the
   * timeout path cannot wait minutes for it.
   */
  timeouts?: { backupMs?: number; cleanMs?: number };
}

/**
 * Budget for one verified recovery snapshot (issue #31).
 *
 * Measured on the owner's host against the 838 MB / 61 833-file DSH package:
 * `cp -a` 3.7–4.0 s warm and 90 s with a cold page cache under load; the content
 * manifest 1.25 s per pass after the batching fix (134 s before it); the closing
 * verification one more manifest pass. Worst observed end-to-end is therefore
 * ~95 s with a cold cache, and a typical run is under 10 s. 300 s is three times
 * the worst measurement, so a slow disk does not fail a healthy snapshot, while
 * the phase markers written by the script still identify whatever was running if
 * the budget is ever exhausted.
 */
const BACKUP_TIMEOUT_MS = 300_000;

/**
 * Budget for removing an interrupted snapshot.
 *
 * Measured: removing an 844 MB / 61 833-file snapshot tree took 0.97 s. 60 s is
 * a sixty-fold margin and stays well below the backup budget, so a stuck removal
 * can never dominate the update.
 */
const CLEAN_TIMEOUT_MS = 60_000;

export function createWslGateway(options: WslGatewayOptions): WslGateway {
  const wslExe = options.wslExe ?? WSL_EXE;
  const spawnImpl = options.spawnImpl ?? spawn;
  const backupTimeoutMs = options.timeouts?.backupMs ?? BACKUP_TIMEOUT_MS;
  const cleanTimeoutMs = options.timeouts?.cleanMs ?? CLEAN_TIMEOUT_MS;

  const run = (args: string[], timeoutMs: number): Promise<CommandResult> =>
    new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        // stdio[0] is 'ignore', so stdin is null; stdout/stderr are piped.
        child = spawnImpl(wslExe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(error);
        return;
      }
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new ShellError('unexpected', 'A WSL command timed out.', 'The distribution may be unresponsive.'));
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        resolve({
          code,
          stdout: stripAnsi(decodeWslOutput(Buffer.concat(stdoutChunks))),
          stderr: stripAnsi(decodeWslOutput(Buffer.concat(stderrChunks))),
        });
      });
    });

  /**
   * Run one long updater step, streaming every line to the modal window.
   *
   * The child gets no TTY and its output is treated as data: escapes and secrets
   * are removed by the terminal buffer, while the last lines are kept here so a
   * failure can explain itself.
   */
  const spawnStreaming = (
    argv: string[],
    onLine: (line: string) => void,
    label: string,
  ): Promise<UpdateRunResult> =>
    new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnImpl(wslExe, argv, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, WSL_UTF8: '1' },
        }) as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        options.log.error(`${label} failed to spawn: ${error instanceof Error ? error.message : 'unknown'}`);
        resolve({ code: null, tail: `${label} could not be started.` });
        return;
      }
      const stdoutBuffer = new LineBuffer();
      const stderrBuffer = new LineBuffer();
      const tail: string[] = [];
      const emit = (line: string): void => {
        const clean = stripAnsi(line);
        if (clean.trim() === '') return;
        tail.push(clean);
        if (tail.length > 20) tail.shift();
        onLine(clean);
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of stdoutBuffer.push(chunk)) emit(line);
      });
      child.stderr.on('data', (chunk: string) => {
        for (const line of stderrBuffer.push(chunk)) emit(line);
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        options.log.error(`${label} error: ${error.code ?? error.message}`);
        resolve({ code: null, tail: tail.slice(-2).join(' ') || `${label} failed to start.` });
      });
      child.once('close', (code) => {
        for (const line of stdoutBuffer.flush()) emit(line);
        for (const line of stderrBuffer.flush()) emit(line);
        resolve({ code, tail: tail.slice(-2).join(' ') });
      });
    });

  const ensureSuccess = (result: CommandResult, message: string): CommandResult => {
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split('\n').slice(-2).join(' ');
      throw new ShellError('unexpected', message, detail === '' ? null : detail);
    }
    return result;
  };

  /**
   * Finish the work of a killed snapshot attempt (issue #31).
   *
   * `wsl.exe` killed at the timeout takes its whole Linux subtree with it, so no
   * writer survives; the script can therefore no longer clean up after itself.
   * The cleanup is transaction-scoped and refuses anything it does not recognize,
   * and it reprints the recorded phase lines so the failure can name the phase.
   */
  const cleanInterruptedSnapshot = async (
    request: PrepareBackupRequest,
  ): Promise<CleanSnapshotReport | null> => {
    try {
      const result = await run(
        buildCleanSnapshotArgs({
          distro: request.distro,
          appRoot: request.appRoot,
          transaction: request.transaction,
        }),
        cleanTimeoutMs,
      );
      const report = parseCleanSnapshotReport(`${result.stdout}\n${result.stderr}`);
      if (report === null) {
        options.log.warn(
          `the leftovers of the interrupted snapshot ${request.transaction} could not be cleaned up (code=${result.code ?? 'null'})`,
        );
        return null;
      }
      if (report.phases.length > 0) {
        const first = report.phases[0]?.at ?? 0;
        const trail = report.phases
          .map((entry) => `${entry.phase}@${Math.max(0, entry.at - first)}ms`)
          .join(' -> ');
        options.log.info(`interrupted snapshot phases (${request.transaction}): ${trail}`);
      } else {
        options.log.info(`the interrupted snapshot ${request.transaction} recorded no phase markers`);
      }
      if (report.removed) {
        options.log.info(`removed the interrupted snapshot directory for ${request.transaction}`);
      }
      return report;
    } catch (error) {
      // A failing cleanup never masks the original failure; it is reported only.
      options.log.warn(
        `the leftovers of the interrupted snapshot ${request.transaction} could not be removed: ${(error as Error).message}`,
      );
      return null;
    }
  };

  const phaseNote = (report: CleanSnapshotReport | null): string | null => {
    const phase = report?.phases.at(-1)?.phase;
    return phase === undefined ? null : `stopped during: ${phase}`;
  };

  const withPhaseNote = (detail: string, report: CleanSnapshotReport | null): string => {
    const note = phaseNote(report);
    if (note === null) return detail;
    return detail === '' ? `the backup step ${note}` : `${detail} (${note})`;
  };

  /**
   * Re-throw a killed command with the phase appended, so the update window and
   * `app.log` say where the budget was spent instead of only "it timed out".
   */
  const withPhaseNoteOnError = (error: unknown, report: CleanSnapshotReport | null): unknown => {
    const note = phaseNote(report);
    if (note === null || !(error instanceof Error)) return error;
    const message = `${error.message} (${note})`;
    if (error instanceof ShellError) return new ShellError(error.code, message, error.hint);
    const wrapped = new Error(message);
    wrapped.name = error.name;
    return wrapped;
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

    async checkPublishedVersion(request) {
      const result = await run(
        buildNpmViewArgs({
          distro: request.distro,
          appRoot: request.appRoot,
          version: request.version,
          nodePath: request.nodePath,
        }),
        120_000,
      );
      const lines = `${result.stdout}\n${result.stderr}`.split('\n');
      const npmPath = lines.map((line) => parseNpmMarker(line)).find((value) => value !== null) ?? null;
      const reported = parseDshVersion(lines.filter((line) => !line.includes(NPM_MARKER)).join('\n'));
      if (npmPath === null) {
        return {
          found: false,
          npmPath: null,
          reported: null,
          message: 'npm was not found in this distribution, so nothing can be verified or installed.',
        };
      }
      if (result.code !== 0 || reported === null) {
        const detail = (result.stderr || result.stdout)
          .split('\n')
          .filter((line) => !line.includes(NPM_MARKER))
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(-1)
          .join(' ');
        return {
          found: false,
          npmPath,
          reported,
          message: detail === '' ? 'npm did not report this version.' : detail,
        };
      }
      return { found: reported === request.version, npmPath, reported, message: null };
    },

    async inspectSharedDsh(request: InspectSharedRequest) {
      const result = await run(
        buildInspectSharedArgs({
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

    async prepareSharedBackup(request: PrepareBackupRequest) {
      const argv = buildPrepareBackupArgs({
        distro: request.distro,
        appRoot: request.appRoot,
        prefix: request.prefix,
        packageDir: request.packageDir,
        dshPath: request.dshPath,
        realPath: request.realPath,
        installedVersion: request.installedVersion,
        transaction: request.transaction,
        nodePath: request.nodePath,
      });
      let result: CommandResult;
      try {
        result = await run(argv, backupTimeoutMs);
      } catch (error) {
        // A killed command is the case that matters most (issue #31): the script
        // could not clean up after itself, so the app does it and names the phase.
        const cleaned = await cleanInterruptedSnapshot(request);
        options.log.error(
          `the recovery snapshot for ${request.installedVersion} could not be created: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
        throw withPhaseNoteOnError(error, cleaned);
      }
      const report = parseBackupReport(`${result.stdout}\n${result.stderr}`);
      if (result.code !== 0 || report === null) {
        // Subprocess output never leaves the gateway unsanitized: the helper
        // strips escapes and control characters, redacts credentials and bounds
        // the line, exactly like a terminal line.
        const detail = backupFailureDetail(result.stdout, result.stderr);
        options.log.error(
          `the recovery snapshot for ${request.installedVersion} could not be created (code=${result.code ?? 'null'}): ` +
            `${detail === '' ? 'no output' : detail}`,
        );
        // The script may have been killed mid-way, so finish its work for it and
        // report which phase was still running when the budget expired.
        const cleaned = await cleanInterruptedSnapshot(request);
        return { ok: false, code: result.code, detail: withPhaseNote(detail, cleaned) };
      }
      options.log.info(`recovery snapshot ready at ${report.path} (${report.files} files, version=${report.version})`);
      return { ok: true, snapshot: { path: report.path, files: report.files } };
    },

    async updateSharedDsh(request: SharedUpdateRunRequest, onLine) {
      const argv = buildUpdateSharedArgs(
        {
          distro: request.distro,
          appRoot: request.appRoot,
          prefix: request.prefix,
          packageDir: request.packageDir,
          dshPath: request.dshPath,
          realPath: request.realPath,
          npmPath: request.npmPath,
          nodePath: request.nodePath,
          transaction: request.transaction,
          version: request.version,
          installedVersion: request.installedVersion,
          ownPid: request.ownPid,
          snapshotDir: request.snapshotDir,
        },
        request.transaction,
      );
      options.log.info(
        `updating the shared DSH installation ${request.installedVersion} -> ${request.version} ` +
          `(prefix=${request.prefix}, tx=${request.transaction})`,
      );
      return await spawnStreaming(argv, onLine, 'the update process');
    },

    async rollbackSharedDsh(request: SharedRollbackRequest, version, transaction, onLine) {
      const argv = buildRollbackSharedArgs(
        {
          distro: request.distro,
          appRoot: request.appRoot,
          prefix: request.prefix,
          packageDir: request.packageDir,
          dshPath: request.dshPath,
          realPath: request.realPath,
          npmPath: request.npmPath,
          nodePath: request.nodePath,
          snapshotDir: request.snapshotDir,
        },
        version,
        transaction,
      );
      options.log.warn(`reinstalling the previous DeepSeek Harness version ${version} (tx=${transaction})`);
      return await spawnStreaming(argv, onLine, 'the rollback process');
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

    async signal(distro, pid, signal) {
      const result = await run(buildSignalArgs(distro, pid, signal), 10_000);
      if (result.code !== 0) {
        options.log.warn(`signal ${signal} to pid ${pid} was not delivered (code=${result.code ?? 'null'})`);
      }
    },
  };
}
