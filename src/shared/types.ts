/** Shared, renderer-safe type definitions. No Electron or Node imports here. */

export const PRESET_DEEPSEEK_HARNESS = 'deepseek-harness' as const;

/**
 * Default root of the isolated backend environment (runtime, `DSH_HOME`,
 * `DSH_AGENTS_HOME`, caches, temp and the test workspace all live below it).
 */
export const ISOLATION_ROOT_DEFAULT = '~/.local/share/wsl-web-shell' as const;
export type PresetId = typeof PRESET_DEEPSEEK_HARNESS;

/** Lifecycle states from `docs/spec.md`. The values are also used in logs. */
export type LifecycleState =
  | 'CHECKING'
  | 'STARTING_WSL'
  | 'STARTING_WEB'
  | 'CONNECTING'
  | 'READY'
  | 'HIDDEN_IN_TRAY'
  | 'RECOVERING'
  | 'ERROR'
  | 'QUITTING';

/** Persistent application configuration (app profile only). */
export interface AppConfig {
  presetId: PresetId;
  /** Existing WSL distribution used for the backend. Never created by the app. */
  distro: string;
  /** Loopback port of the backend WebUI. */
  port: number;
  /** Working directory inside WSL; the DSH web profile treats it as workspace root. */
  workspace: string;
  /** Optional absolute POSIX path to the `dsh` executable inside WSL. */
  dshPath: string | null;
  /** Keep the backend in a private environment (runtime, DSH_HOME, agents home). */
  isolateEnvironment: boolean;
  /** Root directory of the isolated environment inside the distribution. */
  runtimeRoot: string;
  /** Show the window as soon as the shell is ready. */
  openOnLaunch: boolean;
  /** Supervise the owned backend and restart it after unexpected loss. */
  autoRestart: boolean;
  /** Upper bound of consecutive automatic restart attempts. */
  maxRestartAttempts: number;
}

/** Snapshot published to the splash/settings surfaces and the tray. */
export interface ShellStatus {
  state: LifecycleState;
  /** Short, user-facing stage text. Never contains secrets or tokens. */
  message: string;
  /** Optional actionable detail (install hint, collision hint, ...). */
  detail: string | null;
  /** True when the backend process is owned (and stoppable) by this app. */
  ownedServer: boolean;
  canRetry: boolean;
  port: number;
  distro: string;
  /** Restart attempt counter of the current recovery episode. */
  attempt: number;
  maxAttempts: number;
  /** Path of the local log file, shown in the diagnostics view. */
  logPath: string | null;
  updatedAt: string;
}

export interface ConfigPatch {
  distro?: string;
  port?: number;
  workspace?: string;
  dshPath?: string | null;
  isolateEnvironment?: boolean;
  runtimeRoot?: string;
  openOnLaunch?: boolean;
  autoRestart?: boolean;
  maxRestartAttempts?: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  presetId: PRESET_DEEPSEEK_HARNESS,
  distro: 'Ubuntu',
  port: 3080,
  workspace: '~',
  dshPath: null,
  isolateEnvironment: true,
  runtimeRoot: ISOLATION_ROOT_DEFAULT,
  openOnLaunch: true,
  autoRestart: true,
  maxRestartAttempts: 4,
};

export const LOOPBACK_HOST = '127.0.0.1' as const;
