import type {
  ExitInfo,
  InspectSharedRequest,
  NpmVersionCheck,
  ResolvedRuntime,
  ServerHandle,
  PrepareBackupRequest,
  SharedRollbackRequest,
  SharedUpdateRunRequest,
  StartServerRequest,
  UpdateRunResult,
  WslGateway,
} from '../src/main/core/supervisor.js';
import type { ProcessProbe } from '../src/main/wsl/output.js';
import type { SharedInstallObservation } from '../src/main/core/update.js';
import type { DshInstallation, SharedDshReport } from '../src/main/core/dsh-locate.js';
import type { WebClient } from '../src/main/core/supervisor.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { createNullLogger } from '../src/main/core/logger.js';
import { DEFAULT_CONFIG, type AppConfig, type ShellStatus } from '../src/shared/types.js';

/** A realistic npm-global installation used by the update tests. */
export const DEFAULT_INSTALLATION: DshInstallation = {
  path: '/home/dev/.npm-global/bin/dsh',
  realPath: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
  symlink: true,
  version: '0.2.1-rc.5',
  manager: 'npm',
  prefix: '/home/dev/.npm-global',
  packageDir: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh',
  writable: true,
  npmPath: '/usr/bin/npm',
  source: 'login-shell',
  foreignProcesses: 0,
  loginShellRealPath: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
  loginShellVersion: '0.2.1-rc.5',
};

export const BACKEND_PID = 4242;
export type PortState = 'free' | 'occupied';
export const BACKEND_START_TIME = '918273';
export const PORT = 3080;

export function backendProbe(overrides: Partial<ProcessProbe> & { port?: number } = {}): ProcessProbe {
  const port = overrides.port ?? PORT;
  const cmdline =
    `/usr/bin/node /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --host 127.0.0.1 --port ${port} --no-open`;
  const finalCmdline = overrides.cmdline ?? cmdline;
  return {
    startTime: overrides.startTime ?? BACKEND_START_TIME,
    cmdline: finalCmdline,
    argv: finalCmdline.split(' '),
  };
}

export class FakeServer implements ServerHandle {
  readonly pid: Promise<number | null>;
  private readonly listeners = new Set<(line: string) => void>();
  private readonly collected: string[] = [];
  private readonly exitResolvers: ((info: ExitInfo) => void)[] = [];
  stopCalls = 0;
  readonly exited: Promise<ExitInfo>;

  constructor(
    private readonly options: {
      pid?: number | null;
      announceUrl?: boolean;
      urlPort?: number;
      stderr?: string;
    } = {},
  ) {
    this.pid = Promise.resolve(options.pid === undefined ? BACKEND_PID : options.pid);
    this.exited = new Promise<ExitInfo>((resolve) => this.exitResolvers.push(resolve));
  }

  emit(line: string): void {
    this.collected.push(line);
    for (const listener of this.listeners) listener(line);
  }

  announce(): void {
    if (this.options.announceUrl === false) return;
    this.emit(`dsh web: http://127.0.0.1:${this.options.urlPort ?? PORT}/?token=test-token-0123456789abcdef`);
  }

  exit(info: ExitInfo = { code: 1, signal: null }): void {
    for (const resolve of this.exitResolvers) resolve(info);
  }

  lines(): string[] {
    return [...this.collected];
  }

  onLine(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  stderrTail(): string {
    return this.options.stderr ?? 'stderr tail';
  }
}

export interface FakeWslOptions {
  distros?: string[];
  probe?: (pid: number) => ProcessProbe | null;
  pid?: number | null;
  urlPort?: number;
  announceUrl?: boolean;
  dshPath?: string;
  nodePath?: string | null;
  failResolve?: 'dsh-missing' | null;
  failPrepare?: boolean;
  /** Simulate a backend that dies before announcing its WebUI URL. */
  exitBeforeReady?: { code: number | null; stderr?: string };
}

export class FakeWsl implements WslGateway {
  readonly starts: StartServerRequest[] = [];
  readonly signals: { pid: number; signal: 'TERM' | 'KILL' }[] = [];
  readonly servers: FakeServer[] = [];
  distroProbes = 0;
  private readAttempts = 0;

  constructor(public options: FakeWslOptions = {}) {}

  async listDistros(): Promise<string[]> {
    return this.options.distros ?? ['Ubuntu'];
  }

  async ensureDistro(): Promise<void> {
    this.distroProbes += 1;
  }

  /** Version queried from the selected executable (issue #9 footer). */
  dshVersionValue: string | null = '0.2.1-rc.5';
  readonly versionQueries: { distro: string; dshPath: string; nodePath: string | null }[] = [];

  /** Update-related fake state (issues #12 and #17). */
  npmCheckResult: NpmVersionCheck = { found: true, npmPath: '/usr/bin/npm', reported: '0.2.2-rc.1', message: null };
  /** Exit code of the shared-install update, and the lines it streams. */
  updateCode: number | null = 0;
  rollbackCode: number | null = 0;
  updateRunLines: string[] = ['update: installing @deepseek-ai/dsh@0.2.2-rc.1 into /home/dev/.npm-global'];
  /** What the inspection reports before the update. */
  installation: DshInstallation = { ...DEFAULT_INSTALLATION };
  /** What it reports afterwards (the runner verifies the target version). */
  installationAfterUpdate: Partial<DshInstallation> = { version: '0.2.2-rc.1', loginShellVersion: '0.2.2-rc.1' };
  /** What the recovery inspection reports (`null` = use `installation`). */
  recoveryObservation: SharedInstallObservation | null = null;
  legacyRuntimePresent = false;
  readonly updateRuns: SharedUpdateRunRequest[] = [];
  readonly rollbackRuns: { request: SharedRollbackRequest; version: string; transaction: string }[] = [];
  /** Verified snapshot step (B1): recorded, and failable on demand. */
  readonly backupRequests: PrepareBackupRequest[] = [];
  backupFails = false;
  backupFiles = 128;
  readonly npmChecks: { distro: string; appRoot: string; version: string; nodePath: string | null }[] = [];
  readonly inspections: InspectSharedRequest[] = [];

  async checkPublishedVersion(request: {
    distro: string;
    appRoot: string;
    version: string;
    nodePath: string | null;
  }): Promise<NpmVersionCheck> {
    this.npmChecks.push(request);
    return { ...this.npmCheckResult, reported: this.npmCheckResult.reported ?? request.version };
  }

  async inspectSharedDsh(request: InspectSharedRequest): Promise<SharedDshReport> {
    this.inspections.push(request);
    if (this.recoveryObservation !== null) {
      const observation = this.recoveryObservation;
      return {
        found: observation.present,
        legacyRuntimePresent: this.legacyRuntimePresent,
        installation: observation.present
          ? { ...this.installation, version: observation.version, realPath: observation.realPath ?? this.installation.realPath }
          : null,
      };
    }
    return { found: true, installation: { ...this.installation }, legacyRuntimePresent: this.legacyRuntimePresent };
  }

  async prepareSharedBackup(request: PrepareBackupRequest): Promise<{ path: string; files: number } | null> {
    this.backupRequests.push(request);
    if (this.backupFails) return null;
    const root = request.appRoot === '-' ? '/home/dev/.cache/wsl-web-shell' : request.appRoot.replace(/^~/, '/home/dev');
    return { path: `${root}/update/shared-backup-${request.transaction}`, files: this.backupFiles };
  }

  async updateSharedDsh(request: SharedUpdateRunRequest, onLine: (line: string) => void): Promise<UpdateRunResult> {
    this.updateRuns.push(request);
    for (const line of this.updateRunLines) onLine(line);
    if (this.updateCode === 0) {
      // The executable really reports the new version afterwards.
      this.installation = { ...this.installation, ...this.installationAfterUpdate };
    }
    return { code: this.updateCode, tail: this.updateRunLines.slice(-2).join(' ') };
  }

  async rollbackSharedDsh(
    request: SharedRollbackRequest,
    version: string,
    transaction: string,
    onLine: (line: string) => void,
  ): Promise<UpdateRunResult> {
    this.rollbackRuns.push({ request, version, transaction });
    onLine(`update: restoring @deepseek-ai/dsh@${version}`);
    if (this.rollbackCode === 0) {
      this.installation = { ...this.installation, version };
    }
    return { code: this.rollbackCode, tail: this.rollbackCode === 0 ? `update: restored ${version}` : 'update: the previous version could not be restored' };
  }

  async dshVersion(distro: string, dshPath: string, nodePath: string | null = null): Promise<string | null> {
    this.versionQueries.push({ distro, dshPath, nodePath });
    return this.dshVersionValue;
  }

  readonly isolationPreparations: string[] = [];
  readonly runtimeQueries: { isolationRoot: string | null; override: string | null }[] = [];

  async prepareIsolation(_distro: string, root: string): Promise<void> {
    this.isolationPreparations.push(root);
    if (this.options.failPrepare === true) {
      const error = new Error('isolation prepare failed');
      error.name = 'ShellError';
      throw error;
    }
  }

  async resolveRuntime(
    _distro: string,
    override: string | null,
    isolationRoot: string | null,
  ): Promise<ResolvedRuntime> {
    this.runtimeQueries.push({ isolationRoot, override });
    if (this.options.failResolve === 'dsh-missing') {
      const error = new Error('dsh missing');
      error.name = 'ShellError';
      throw error;
    }
    return {
      dshPath: override ?? this.options.dshPath ?? '/usr/local/bin/dsh',
      nodePath: this.options.nodePath === undefined ? '/usr/bin/node' : this.options.nodePath,
    };
  }

  startHook: (() => void) | null = null;

  startServer(request: StartServerRequest): ServerHandle {
    this.starts.push(request);
    this.startHook?.();
    const exitBeforeReady = this.options.exitBeforeReady;
    const server = new FakeServer({
      pid: this.options.pid === undefined ? BACKEND_PID : this.options.pid,
      urlPort: this.options.urlPort ?? request.port,
      announceUrl: exitBeforeReady === undefined ? this.options.announceUrl : false,
      stderr: exitBeforeReady?.stderr,
    });
    this.servers.push(server);
    // Announce asynchronously, like the real process would.
    queueMicrotask(() => {
      if (exitBeforeReady !== undefined) {
        server.exit({ code: exitBeforeReady.code, signal: null });
        return;
      }
      server.announce();
    });
    return server;
  }

  async probeProcess(_distro: string, pid: number): Promise<ProcessProbe | null> {
    this.readAttempts += 1;
    if (this.options.probe !== undefined) return this.options.probe(pid);
    return pid === BACKEND_PID ? backendProbe() : null;
  }

  signalHook: ((pid: number, signal: 'TERM' | 'KILL') => void) | null = null;

  async signal(_distro: string, pid: number, signal: 'TERM' | 'KILL'): Promise<void> {
    this.signals.push({ pid, signal });
    this.signalHook?.(pid, signal);
  }

  get probeCalls(): number {
    return this.readAttempts;
  }
}

export class FakeWeb implements WebClient {
  bootstraps: string[] = [];
  healthCalls = 0;

  constructor(
    private readonly options: {
      bootstrapStatus?: number;
      health?: () => number;
    } = {},
  ) {}

  async bootstrapToken(_tokenUrl: string): Promise<number> {
    this.bootstraps.push(_tokenUrl);
    return this.options.bootstrapStatus ?? 200;
  }

  async health(): Promise<number> {
    this.healthCalls += 1;
    return this.options.health === undefined ? 200 : this.options.health();
  }
}

export interface HarnessOptions {
  config?: Partial<AppConfig>;
  wsl?: FakeWslOptions;
  web?: { bootstrapStatus?: number; health?: () => number };
  portState?: PortState | (() => PortState);
  registry?: ReturnType<typeof createMemoryRegistry>;
}

export function createHarness(options: HarnessOptions = {}) {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...options.config };
  const statuses: ShellStatus[] = [];
  const wsl = new FakeWsl(options.wsl);
  const web = new FakeWeb(options.web);
  const registry = options.registry ?? createMemoryRegistry();
  const probeCalls: number[] = [];
  return {
    config,
    wsl,
    web,
    registry,
    statuses,
    probeCalls,
    deps: {
      config: () => config,
      wsl,
      web,
      registry,
      log: createNullLogger(),
      probePort: async (port: number) => {
        probeCalls.push(port);
        const state = options.portState ?? 'free';
        return typeof state === 'function' ? state() : state;
      },
      sleep: async (_ms: number) => undefined,
      now: () => Date.now(),
      publish: (status: ShellStatus) => statuses.push(status),
      appVersion: '0.0.0-test',
      logPath: () => '/tmp/app.log',
      startupTimeoutMs: 2_000,
      healthAttempts: 2,
      stopGraceMs: 0,
    },
  };
}

export function lastStatus(statuses: ShellStatus[]): ShellStatus {
  const status = statuses.at(-1);
  if (status === undefined) throw new Error('no status published');
  return status;
}

