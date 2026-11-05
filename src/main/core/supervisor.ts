/**
 * Backend supervisor: startup, ownership, health, bounded recovery, shutdown.
 *
 * All side effects arrive through injected gateways, so the whole lifecycle is
 * unit-testable without Electron, WSL or a real DeepSeek Harness installation.
 */
import type { AppConfig, LifecycleState, ShellStatus } from '../../shared/types.js';
import { LOOPBACK_HOST } from '../../shared/types.js';
import { parseStartupLine, buildOrigin } from '../backend/urls.js';
import type { ProcessProbe } from '../wsl/output.js';
import type { Logger } from './logger.js';
import type { RegistryStore } from './registry.js';
import { Lifecycle, backoffDelay } from './lifecycle.js';
import { verifyOwnership, type OwnedServerRecord } from './ownership.js';
import { classifyPortSituation, type PortState } from './port.js';
import { sanitizeOptional } from './display.js';

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface ServerHandle {
  /** Resolves once the wrapper announced the Linux PID. */
  pid: Promise<number | null>;
  /** Lines already emitted, so late subscribers never miss the URL line. */
  lines(): string[];
  onLine(listener: (line: string) => void): () => void;
  exited: Promise<ExitInfo>;
  /** Terminates the Windows-side `wsl.exe` launcher. */
  stop(): Promise<void>;
  stderrTail(): string;
}

export interface StartServerRequest {
  distro: string;
  dshPath: string;
  port: number;
  workspace: string;
  host: string;
}

export interface WslGateway {
  listDistros(): Promise<string[]>;
  /** Any `wsl.exe` invocation starts a stopped distribution. */
  ensureDistro(distro: string): Promise<void>;
  resolveDshPath(distro: string, override: string | null): Promise<string>;
  startServer(request: StartServerRequest): ServerHandle;
  probeProcess(distro: string, pid: number): Promise<ProcessProbe | null>;
  signal(distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<void>;
}

export interface WebClient {
  /** Exchanges the tokenized startup URL for a session cookie. */
  bootstrapToken(tokenUrl: string): Promise<number>;
  /** Unauthenticated-by-URL health probe against the loopback origin. */
  health(origin: string): Promise<number>;
}

export interface SupervisorDeps {
  config(): AppConfig;
  wsl: WslGateway;
  web: WebClient;
  registry: RegistryStore;
  log: Logger;
  probePort(port: number): Promise<PortState>;
  sleep(ms: number): Promise<void>;
  now(): number;
  publish(status: ShellStatus): void;
  appVersion: string;
  logPath(): string;
  startupTimeoutMs?: number;
  healthAttempts?: number;
  stopGraceMs?: number;
}

export type ShellErrorCode =
  | 'wsl-missing'
  | 'distro-missing'
  | 'dsh-missing'
  | 'port-collision'
  | 'start-timeout'
  | 'auth-failed'
  | 'health-failed'
  | 'backend-lost'
  | 'retry-exhausted'
  | 'unexpected';

export class ShellError extends Error {
  constructor(
    readonly code: ShellErrorCode,
    message: string,
    readonly hint: string | null = null,
  ) {
    super(message);
    this.name = 'ShellError';
  }
}

const STATE_MESSAGES: Record<LifecycleState, string> = {
  CHECKING: 'Checking environment',
  STARTING_WSL: 'Starting Windows Subsystem for Linux',
  STARTING_WEB: 'Starting DeepSeek Harness',
  CONNECTING: 'Connecting to WebUI',
  READY: 'Ready',
  HIDDEN_IN_TRAY: 'Running in the notification area',
  RECOVERING: 'Reconnecting',
  ERROR: 'Backend unavailable',
  QUITTING: 'Shutting down',
};

export class Supervisor {
  private readonly lifecycle = new Lifecycle();
  private status: ShellStatus;
  private lock: Promise<unknown> = Promise.resolve();
  private server: ServerHandle | null = null;
  private serverPid: number | null = null;
  private serverStartTime: string | null = null;
  /** Backend settings captured when the current server was brought up. */
  private activePort: number | null = null;
  private activeDistro: string | null = null;
  private owned = false;
  private failures = 0;
  private attempt = 0;
  private recoveryRunning = false;
  private quitting = false;
  private detail: string | null = null;
  /** Last known window visibility, so recovery can restore the tray state. */
  private windowHidden = false;
  private readyCount = 0;

  constructor(private readonly deps: SupervisorDeps) {
    this.status = this.buildStatus('CHECKING', null);
    this.lifecycle.onChange((state) => {
      this.status = this.buildStatus(state, this.detail);
      this.deps.publish(this.status);
    });
  }

  getStatus(): ShellStatus {
    return this.status;
  }

  get state(): LifecycleState {
    return this.lifecycle.state;
  }

  /**
   * Increments every time the backend becomes usable. The window layer uses it
   * to force a real reload after a restart instead of trusting the old page.
   */
  get readyGeneration(): number {
    return this.readyCount;
  }

  /** True when the user closed the window to the tray. */
  get isWindowHidden(): boolean {
    return this.windowHidden;
  }

  private buildStatus(state: LifecycleState, detail: string | null): ShellStatus {
    const config = this.deps.config();
    return {
      state,
      message: STATE_MESSAGES[state],
      // Every published string is sanitized: diagnostics may embed backend
      // output, exception text or a URL that once carried a launch token.
      detail: sanitizeOptional(detail),
      ownedServer: this.owned,
      canRetry: state === 'ERROR',
      port: this.port(),
      distro: config.distro,
      attempt: this.attempt,
      maxAttempts: config.maxRestartAttempts,
      logPath: this.deps.logPath(),
      updatedAt: new Date(this.deps.now()).toISOString(),
    };
  }

  private port(): number {
    return this.activePort ?? this.deps.config().port;
  }

  private distro(): string {
    return this.activeDistro ?? this.deps.config().distro;
  }

  private setState(state: LifecycleState, detail: string | null = null): void {
    this.detail = detail;
    if (state === this.lifecycle.state) {
      this.status = this.buildStatus(state, detail);
      this.deps.publish(this.status);
      return;
    }
    this.lifecycle.transition(state);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.lock.then(task, task);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** First launch or manual retry: serialized, never parallel. */
  start(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      // Repeated launches must never spawn a second server for the same port.
      if (this.owned && (this.lifecycle.state === 'READY' || this.lifecycle.state === 'HIDDEN_IN_TRAY' || this.lifecycle.state === 'CONNECTING')) {
        return;
      }
      this.attempt = 0;
      await this.bringUp();
    });
  }

  /** Tray "Restart WebUI": always restarts the app-owned backend. */
  restart(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      if (!this.owned) {
        this.setDetail('Only the backend started by this app can be restarted.');
        return;
      }
      this.attempt = 0;
      this.setState('RECOVERING', 'Restarting DeepSeek Harness');
      await this.stopOwnedServer();
      await this.bringUp();
    });
  }

  /** Retry from a terminal error state. */
  retry(): Promise<void> {
    return this.serial(async () => {
      if (this.quitting) return;
      if (this.lifecycle.state === 'ERROR') this.setState('CHECKING', null);
      this.attempt = 0;
      await this.bringUp();
    });
  }

  markHidden(hidden: boolean): void {
    this.windowHidden = hidden;
    const state = this.lifecycle.state;
    if (hidden && state === 'READY') {
      this.setState('HIDDEN_IN_TRAY', null);
    } else if (!hidden && state === 'HIDDEN_IN_TRAY') {
      this.setState('READY', null);
    }
  }

  /** Health tick driven by the main process (visible ~10 s, hidden ~25 s). */
  async healthTick(): Promise<void> {
    const state = this.lifecycle.state;
    if (state !== 'READY' && state !== 'HIDDEN_IN_TRAY') return;
    const origin = buildOrigin(this.port());
    let code: number;
    try {
      code = await this.deps.web.health(origin);
    } catch {
      code = 0;
    }
    if (code === 200) {
      this.failures = 0;
      return;
    }
    this.failures += 1;
    this.deps.log.warn(`health probe failed (status=${code}, consecutive=${this.failures})`);
    if (this.failures < 2) return;
    this.failures = 0;
    await this.handleLoss('health-check-failed');
  }

  /** Unexpected process death, wired by the main process. */
  async handleServerExit(exit: ExitInfo): Promise<void> {
    if (this.quitting || this.lifecycle.state === 'QUITTING' || this.lifecycle.state === 'ERROR') return;
    const active: LifecycleState[] = ['STARTING_WEB', 'CONNECTING', 'READY', 'HIDDEN_IN_TRAY'];
    if (!active.includes(this.lifecycle.state)) return;
    this.deps.log.warn(`backend exited unexpectedly (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'})`);
    await this.handleLoss('process-exited');
  }

  private async handleLoss(reason: string): Promise<void> {
    if (this.recoveryRunning || this.quitting) return;
    this.recoveryRunning = true;
    try {
      this.setState('RECOVERING', reason === 'process-exited' ? 'DeepSeek Harness stopped unexpectedly' : 'Connection to DeepSeek Harness lost');
      this.deps.log.info(`recovery started (${reason})`);

      // Keep the recorded PID/start time until the process is proven gone or
      // stopped: a hung-but-alive backend still has to be reclaimed safely.
      await this.releaseOwnedProcess();

      const config = this.deps.config();
      if (!config.autoRestart) {
        this.owned = false;
        this.fail(new ShellError('backend-lost', 'The DeepSeek Harness web server is not running.', 'Automatic restart is disabled in settings.'));
        return;
      }

      for (let attempt = 1; attempt <= config.maxRestartAttempts; attempt += 1) {
        this.attempt = attempt;
        this.setState('RECOVERING', `Restarting backend (attempt ${attempt} of ${config.maxRestartAttempts})`);
        await this.deps.sleep(backoffDelay(attempt - 1));
        if (this.quitting) return;
        try {
          await this.bringUp();
          this.deps.log.info(`recovery succeeded on attempt ${attempt}`);
          this.attempt = 0;
          this.recoveryRunning = false;
          return;
        } catch (error) {
          this.deps.log.error(`recovery attempt ${attempt} failed: ${describe(error)}`);
          if (error instanceof ShellError && error.code === 'port-collision') {
            this.fail(error);
            return;
          }
        }
      }
      this.fail(
        new ShellError(
          'retry-exhausted',
          `The web server could not be restarted after ${config.maxRestartAttempts} attempts.`,
          'Use Retry after checking the log and the WSL distribution.',
        ),
      );
    } finally {
      this.recoveryRunning = false;
    }
  }

  private async bringUp(): Promise<void> {
    const config = this.deps.config();
    try {
      this.activePort = config.port;
      this.activeDistro = config.distro;
      this.setState('CHECKING', null);
      this.failures = 0;

      const distros = await this.deps.wsl.listDistros();
      if (!distros.includes(config.distro)) {
        throw new ShellError(
          'distro-missing',
          `WSL distribution "${config.distro}" is not installed.`,
          'Install the distribution (for example "wsl --install -d Ubuntu") or pick another distro in Settings.',
        );
      }

      this.setState('STARTING_WSL', `Starting ${config.distro}`);
      await this.deps.wsl.ensureDistro(config.distro);

      // A previous in-session backend (healthy, hung or already dead) is
      // resolved before anything else can fail, so a hung owned process never
      // survives a failed recovery attempt.
      await this.releaseOwnedProcess();

      const dshPath = await this.deps.wsl.resolveDshPath(config.distro, config.dshPath);

      const portState = await this.deps.probePort(config.port);
      let reassessed = portState;
      if (portState === 'occupied') {
        const existing = await this.verifyRecordedServer();
        const situation = classifyPortSituation(portState, existing.verdict);
        if (situation === 'collision') {
          this.deps.registry.clear();
          throw new ShellError(
            'port-collision',
            `Port ${config.port} is already in use by a service this app does not own.`,
            'Close the other service or choose another port in Settings. The app never connects to unknown listeners.',
          );
        }
        this.deps.log.info('reusing app-owned backend');
        this.owned = true;
        this.serverPid = existing.record?.pid ?? null;
        this.serverStartTime = existing.record?.startTime ?? null;
        this.setState('CONNECTING', null);
        const authenticated = await this.tryExistingSession();
        if (authenticated) {
          await this.finishReady();
          return;
        }
        this.deps.log.warn('owned backend rejected the stored session cookie; restarting it');
        await this.stopOwnedServer();
        reassessed = await this.deps.probePort(config.port);
        if (reassessed === 'occupied') {
          throw new ShellError(
            'port-collision',
            `Port ${config.port} is still in use after stopping the app-owned backend.`,
            'Check the port with "ss -ltnp" inside WSL and pick another port in Settings.',
          );
        }
      }

      await this.spawnServer(dshPath);
      await this.finishReady();
    } catch (error) {
      // Never leave a half-started process behind.
      await this.stopOwnedServer().catch(() => undefined);
      this.owned = false;
      this.fail(
        error instanceof ShellError
          ? error
          : new ShellError('unexpected', describe(error), 'See the log for details.'),
      );
      throw error;
    }
  }

  private async spawnServer(dshPath: string): Promise<void> {
    const config = this.deps.config();
    this.setState('STARTING_WEB', null);

    const handle = this.deps.wsl.startServer({
      distro: config.distro,
      dshPath,
      port: this.port(),
      workspace: config.workspace,
      host: LOOPBACK_HOST,
    });
    this.server = handle;
    this.owned = true;

    void handle.exited
      .then((exit) => this.handleServerExit(exit))
      .catch((error: unknown) => this.deps.log.error(`exit handler failed: ${describe(error)}`));

    const pid = await this.withTimeout(handle.pid, 15_000, 'start-timeout', 'The backend did not report its process id.');
    if (pid === null) {
      throw new ShellError('start-timeout', 'The backend did not report its process id.', 'See the log for the raw output.');
    }
    this.serverPid = pid;

    const probe = await this.waitForProbe(config.distro, pid, 5_000);
    const verdict = verifyOwnership(probe, { port: this.port() });
    if (verdict !== 'owned' || probe === null) {
      throw new ShellError(
        'unexpected',
        'The started process could not be verified as the DeepSeek Harness backend.',
        'The app only manages processes it can prove it started.',
      );
    }
    this.serverStartTime = probe.startTime;
    this.deps.registry.write({
      presetId: config.presetId,
      distro: config.distro,
      port: this.port(),
      pid,
      startTime: probe.startTime,
      workspace: config.workspace,
      startedAt: new Date(this.deps.now()).toISOString(),
      appVersion: this.deps.appVersion,
    } satisfies OwnedServerRecord);

    this.setState('CONNECTING', null);
    const tokenUrl = await this.waitForStartupUrl(handle);
    const status = await this.deps.web.bootstrapToken(tokenUrl);
    if (status === 401 || status === 403) {
      throw new ShellError('auth-failed', 'The WebUI rejected the startup token.', 'Restart the backend from the tray menu.');
    }
    if (status >= 400) {
      throw new ShellError('auth-failed', `The WebUI login exchange failed (HTTP ${status}).`, 'Restart the backend from the tray menu.');
    }
  }

  private async waitForProbe(distro: string, pid: number, timeoutMs: number): Promise<ProcessProbe | null> {
    const deadline = this.deps.now() + timeoutMs;
    let probe: ProcessProbe | null = null;
    while (this.deps.now() <= deadline) {
      probe = await this.deps.wsl.probeProcess(distro, pid);
      if (probe !== null && probe.startTime !== '') return probe;
      await this.deps.sleep(150);
    }
    return probe;
  }

  private async waitForStartupUrl(handle: ServerHandle): Promise<string> {
    const deadline = this.deps.now() + (this.deps.startupTimeoutMs ?? 60_000);
    const tryParse = (lines: string[]): string | null => {
      for (const line of lines) {
        const parsed = parseStartupLine(line, { port: this.port() });
        if (parsed.ok) return parsed.tokenUrl;
        if (!parsed.ok && line.startsWith('dsh web: ') && parsed.error !== 'not-a-startup-line') {
          this.deps.log.warn(`rejected startup URL line (${parsed.error})`);
        }
      }
      return null;
    };

    const immediate = tryParse(handle.lines());
    if (immediate !== null) return immediate;

    return await new Promise<string>((resolve, reject) => {
      const seen: string[] = [...handle.lines()];
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new ShellError('start-timeout', 'The backend did not announce a WebUI URL in time.', 'Inspect the log: the backend may still be booting, or the frontend build is missing.'));
      }, Math.max(1_000, deadline - this.deps.now()));
      const unsubscribe = handle.onLine((line) => {
        seen.push(line);
        const found = tryParse([line]);
        if (found !== null) {
          clearTimeout(timer);
          unsubscribe();
          resolve(found);
        }
      });
      void handle.exited.then((exit) => {
        clearTimeout(timer);
        unsubscribe();
        reject(
          new ShellError(
            'backend-lost',
            `The backend exited before it became ready (code=${exit.code ?? 'null'}).`,
            this.server?.stderrTail().slice(-600) ?? null,
          ),
        );
      });
    });
  }

  private async tryExistingSession(): Promise<boolean> {
    const origin = buildOrigin(this.port());
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const status = await this.deps.web.health(origin);
        if (status === 200) return true;
        if (status === 401 || status === 403) return false;
      } catch {
        // Server may still be starting.
      }
      await this.deps.sleep(300);
    }
    return false;
  }

  private async finishReady(): Promise<void> {
    const origin = buildOrigin(this.port());
    const attempts = this.deps.healthAttempts ?? 20;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.deps.web.health(origin);
      if (status === 200) {
        this.failures = 0;
        this.attempt = 0;
        this.readyCount += 1;
        // Restore the tray state the user chose: a hidden window stays hidden.
        const target: LifecycleState = this.windowHidden ? 'HIDDEN_IN_TRAY' : 'READY';
        if (this.lifecycle.state !== target) this.setState(target, null);
        this.deps.log.info('backend ready');
        return;
      }
      await this.deps.sleep(250);
    }
    throw new ShellError('health-failed', 'The WebUI did not answer over loopback.', 'Check the log and whether another process holds the port.');
  }

  private async verifyRecordedServer(): Promise<{ verdict: 'owned' | 'foreign' | 'gone'; record: OwnedServerRecord | null }> {
    const record = this.deps.registry.read();
    if (record === null) return { verdict: 'gone', record: null };
    if (record.distro !== this.distro() || record.port !== this.port()) {
      this.deps.registry.clear();
      return { verdict: 'gone', record: null };
    }
    const probe = await this.deps.wsl.probeProcess(this.distro(), record.pid);
    const verdict = verifyOwnership(probe, { port: this.port(), startTime: record.startTime });
    if (verdict !== 'owned') this.deps.registry.clear();
    return { verdict, record };
  }

  /**
   * Resolve a backend this app started before a new start/recovery.
   *
   * Ownership is verified first: a live app-owned process is stopped with
   * TERM/KILL, a vanished one is simply forgotten, and a PID that no longer
   * matches the recorded start time is left untouched.
   */
  private async releaseOwnedProcess(): Promise<void> {
    if (!this.owned && this.serverPid === null && this.server === null) return;
    await this.stopOwnedServer();
  }

  /**
   * Graceful, ownership-checked termination of the backend this app started.
   *
   * Identity is verified three times: before TERM, before the escalated KILL
   * (so a recycled PID is never targeted) and, for the KILL, once more as
   * close to the signal as possible.
   */
  private async stopOwnedServer(): Promise<void> {
    const pid = this.serverPid;
    const startTime = this.serverStartTime;
    const expectation = { port: this.port(), startTime };

    if (pid !== null) {
      const probe = await this.deps.wsl.probeProcess(this.distro(), pid);
      const verdict = verifyOwnership(probe, expectation);
      if (verdict === 'owned') {
        this.deps.log.info(`stopping owned backend pid=${pid}`);
        await this.deps.wsl.signal(this.distro(), pid, 'TERM').catch(() => undefined);

        const graceMs = this.deps.stopGraceMs ?? 5_000;
        const deadline = this.deps.now() + graceMs;
        let check = await this.deps.wsl.probeProcess(this.distro(), pid);
        while (check !== null && this.deps.now() < deadline) {
          await this.deps.sleep(200);
          check = await this.deps.wsl.probeProcess(this.distro(), pid);
        }

        // Revalidate the full identity (PID + start time + command line) right
        // before escalating: the PID may have been recycled while we waited.
        const finalProbe = check === null ? null : await this.deps.wsl.probeProcess(this.distro(), pid);
        const finalVerdict = verifyOwnership(finalProbe, expectation);
        if (finalVerdict === 'owned') {
          const confirmed = await this.deps.wsl.probeProcess(this.distro(), pid);
          if (verifyOwnership(confirmed, expectation) === 'owned') {
            this.deps.log.warn(`backend pid=${pid} ignored SIGTERM; sending SIGKILL`);
            await this.deps.wsl.signal(this.distro(), pid, 'KILL').catch(() => undefined);
          } else {
            this.deps.log.warn(`pid=${pid} no longer matches the owned backend; SIGKILL withheld`);
          }
        } else if (finalVerdict === 'foreign') {
          this.deps.log.warn(`pid=${pid} no longer matches the owned backend; leaving it alone`);
        }
      } else if (verdict === 'foreign') {
        this.deps.log.warn(`pid=${pid} no longer matches the owned backend; leaving it alone`);
      }
    } else if (this.server !== null) {
      // Spawned but no PID was observed yet: only the launcher handle exists.
      this.deps.log.warn('stopping backend launcher without a known pid');
    }

    if (this.server !== null) {
      await this.server.stop().catch(() => undefined);
    }
    if (pid !== null) this.deps.registry.clear();
    this.server = null;
    this.serverPid = null;
    this.serverStartTime = null;
    this.owned = false;
  }

  /** Fully serialized shutdown; stops only the process this app owns. */
  async shutdown(): Promise<void> {
    if (this.quitting) return;
    this.quitting = true;
    this.lifecycle.forceQuit();
    this.status = this.buildStatus('QUITTING', null);
    this.deps.publish(this.status);
    await this.serial(async () => {
      await this.stopOwnedServer();
    });
  }

  private fail(error: ShellError): void {
    const message = error.hint === null ? error.message : `${error.message} ${error.hint}`;
    this.deps.log.error(`terminal: ${message}`);
    if (this.lifecycle.state === 'QUITTING' || this.quitting) return;
    try {
      this.setState('ERROR', message);
    } catch {
      this.detail = message;
      this.status = this.buildStatus('ERROR', message);
      this.deps.publish(this.status);
    }
  }

  private setDetail(detail: string): void {
    this.detail = detail;
    this.status = this.buildStatus(this.lifecycle.state, detail);
    this.deps.publish(this.status);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: ShellErrorCode, message: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ShellError(code, message, 'See the log for details.')), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
