import type {
  ExitInfo,
  InspectSharedRequest,
  ResolvedRuntime,
  ServerHandle,
  StartServerRequest,
  WslGateway,
} from '../src/main/core/supervisor.js';
import type { ProcessProbe } from '../src/main/wsl/output.js';
import type { ManagedBackend } from '../src/main/wsl/managed.js';
import type { DshInstallation, SharedDshReport } from '../src/main/core/dsh-locate.js';
import type { WebClient } from '../src/main/core/supervisor.js';
import { createMemoryExternalStore } from '../src/main/core/external.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { createNullLogger } from '../src/main/core/logger.js';
import { DEFAULT_CONFIG, type AppConfig, type ShellStatus } from '../src/shared/types.js';

export const BACKEND_PID = 4242;
export const KEEPALIVE_PID = 5151;
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
  /** PID reported as the listener on a port (attach verification). */
  portOwner?: number | null | ((port: number) => number | null);
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

  /** Installation reported by the read-only inspection. */
  installation: DshInstallation = {
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
    foreignPids: [],
    loginShellRealPath: '/home/dev/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js',
    loginShellVersion: '0.2.1-rc.5',
  };
  legacyRuntimePresent = false;
  readonly inspections: InspectSharedRequest[] = [];

  async inspectSharedDsh(request: InspectSharedRequest): Promise<SharedDshReport> {
    this.inspections.push(request);
    return { found: true, installation: { ...this.installation }, legacyRuntimePresent: this.legacyRuntimePresent };
  }

  /** What the app believes owns a backend pid; tests override it per case. */
  managed: ManagedBackend = { scope: 'none', unit: null, user: 'triag' };
  readonly probedManagedPids: number[] = [];

  async probeManagedBackend(request: { distro: string; pid: number }): Promise<ManagedBackend> {
    this.probedManagedPids.push(request.pid);
    return this.managed;
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

  readonly recoveryNodeQueries: string[] = [];
  async resolveRecoveryNode(distro: string): Promise<string | null> {
    this.recoveryNodeQueries.push(distro);
    return this.options.nodePath === undefined ? '/usr/bin/node' : this.options.nodePath;
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
    // The command line of a backend this fake started carries the port it was
    // started with: the app may serve beside a reserved port, and ownership is
    // verified against the port in use.
    return pid === BACKEND_PID ? backendProbe({ port: this.lastStartPort() }) : null;
  }

  /** Port of the most recent start request, or the fixed port before one. */
  lastStartPort(): number {
    const last = this.starts[this.starts.length - 1];
    return last === undefined ? PORT : last.port;
  }

  async findPortOwner(_distro: string, port: number): Promise<number | null> {
    const owner = this.options.portOwner;
    if (typeof owner === 'function') return owner(port);
    return owner ?? null;
  }

  /** Sessions this fake was asked to keep alive, by distribution. */
  readonly keepalives: string[] = [];

  async ensureKeepalive(distro: string): Promise<number | null> {
    this.keepalives.push(distro);
    return KEEPALIVE_PID;
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
      health?: (origin: string) => number;
    } = {},
  ) {}

  async bootstrapToken(_tokenUrl: string): Promise<number> {
    this.bootstraps.push(_tokenUrl);
    return this.options.bootstrapStatus ?? 200;
  }

  async health(origin = ''): Promise<number> {
    this.healthCalls += 1;
    return this.options.health === undefined ? 200 : this.options.health(origin);
  }
}

export interface HarnessOptions {
  config?: Partial<AppConfig>;
  wsl?: FakeWslOptions;
  web?: { bootstrapStatus?: number; health?: (origin: string) => number };
  portState?: PortState | ((port: number) => PortState);
  registry?: ReturnType<typeof createMemoryRegistry>;
  external?: ReturnType<typeof createMemoryExternalStore>;
  /** Bounded wait for an expected external backend; tests keep it short. */
  attachWaitMs?: number;
  attachPollMs?: number;
  discoveryGraceMs?: number;
  discoveryPollMs?: number;
}

export function createHarness(options: HarnessOptions = {}) {
  const config: AppConfig = { ...DEFAULT_CONFIG, ...options.config };
  const statuses: ShellStatus[] = [];
  const wsl = new FakeWsl(options.wsl);
  const web = new FakeWeb(options.web);
  const registry = options.registry ?? createMemoryRegistry();
  const external = options.external ?? createMemoryExternalStore();
  const probeCalls: number[] = [];
  return {
    config,
    wsl,
    web,
    registry,
    external,
    statuses,
    probeCalls,
    deps: {
      config: () => config,
      wsl,
      web,
      registry,
      external,
      log: createNullLogger(),
      probePort: async (port: number) => {
        probeCalls.push(port);
        const state = options.portState ?? 'free';
        return typeof state === 'function' ? state(port) : state;
      },
      sleep: async (_ms: number) => undefined,
      now: () => Date.now(),
      publish: (status: ShellStatus) => statuses.push(status),
      appVersion: '0.0.0-test',
      logPath: () => '/tmp/app.log',
      startupTimeoutMs: 2_000,
      healthAttempts: 2,
      stopGraceMs: 0,
      attachWaitMs: options.attachWaitMs ?? 20,
      attachPollMs: options.attachPollMs ?? 5,
      discoveryGraceMs: options.discoveryGraceMs ?? 0,
      discoveryPollMs: options.discoveryPollMs ?? 5,
    },
  };
}

export function lastStatus(statuses: ShellStatus[]): ShellStatus {
  const status = statuses.at(-1);
  if (status === undefined) throw new Error('no status published');
  return status;
}

