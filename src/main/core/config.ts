/** Configuration validation. Pure: no fs, no Electron. */
import { isValidIsolationRoot } from './isolation.js';
import {
  DEFAULT_CONFIG,
  PRESET_DEEPSEEK_HARNESS,
  type AppConfig,
  type ConfigPatch,
  type PresetId,
} from '../../shared/types.js';

const DISTRO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WORKSPACE_PATTERN = /^(?:~|\/)[^\0\r\n\\]*$/;

export function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1024 && value <= 65535;
}

export function isValidDistro(value: unknown): value is string {
  return typeof value === 'string' && DISTRO_PATTERN.test(value);
}

export function isValidWorkspace(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && WORKSPACE_PATTERN.test(value);
}

export function isValidDshPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    value.length <= 4096 &&
    !/[\0\r\n]/.test(value) &&
    !value.split('/').includes('..')
  );
}

/** Coerce arbitrary persisted data into a usable configuration. */
export function normalizeConfig(input: unknown): AppConfig {
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const presetId: PresetId = PRESET_DEEPSEEK_HARNESS;
  return {
    presetId,
    distro: isValidDistro(source.distro) ? source.distro : DEFAULT_CONFIG.distro,
    port: isValidPort(source.port) ? source.port : DEFAULT_CONFIG.port,
    workspace: isValidWorkspace(source.workspace) ? source.workspace : DEFAULT_CONFIG.workspace,
    dshPath: isValidDshPath(source.dshPath) ? source.dshPath : null,
    isolateEnvironment:
      typeof source.isolateEnvironment === 'boolean' ? source.isolateEnvironment : DEFAULT_CONFIG.isolateEnvironment,
    runtimeRoot: isValidIsolationRoot(source.runtimeRoot) ? source.runtimeRoot : DEFAULT_CONFIG.runtimeRoot,
    openOnLaunch: typeof source.openOnLaunch === 'boolean' ? source.openOnLaunch : DEFAULT_CONFIG.openOnLaunch,
    autoRestart: typeof source.autoRestart === 'boolean' ? source.autoRestart : DEFAULT_CONFIG.autoRestart,
    maxRestartAttempts:
      typeof source.maxRestartAttempts === 'number' &&
      Number.isInteger(source.maxRestartAttempts) &&
      source.maxRestartAttempts >= 0 &&
      source.maxRestartAttempts <= 20
        ? source.maxRestartAttempts
        : DEFAULT_CONFIG.maxRestartAttempts,
  };
}

export interface PatchResult {
  config: AppConfig;
  errors: string[];
  changed: boolean;
}

/** Apply a user-supplied patch, rejecting invalid values field by field. */
export function applyConfigPatch(current: AppConfig, patch: ConfigPatch): PatchResult {
  const next: AppConfig = { ...current };
  const errors: string[] = [];

  if (patch.distro !== undefined) {
    if (isValidDistro(patch.distro)) next.distro = patch.distro;
    else errors.push('distro: expected an installed WSL distribution name');
  }
  if (patch.port !== undefined) {
    if (isValidPort(patch.port)) next.port = patch.port;
    else errors.push('port: expected an integer between 1024 and 65535');
  }
  if (patch.workspace !== undefined) {
    if (isValidWorkspace(patch.workspace)) next.workspace = patch.workspace;
    else errors.push('workspace: expected an absolute POSIX path such as /home/user/projects');
  }
  if (patch.dshPath !== undefined) {
    if (patch.dshPath === null || patch.dshPath === '') next.dshPath = null;
    else if (isValidDshPath(patch.dshPath)) next.dshPath = patch.dshPath;
    else errors.push('dshPath: expected an absolute path inside the distribution');
  }
  if (patch.isolateEnvironment !== undefined) {
    if (typeof patch.isolateEnvironment === 'boolean') next.isolateEnvironment = patch.isolateEnvironment;
    else errors.push('isolateEnvironment: expected a boolean');
  }
  if (patch.runtimeRoot !== undefined) {
    if (isValidIsolationRoot(patch.runtimeRoot)) next.runtimeRoot = patch.runtimeRoot;
    else errors.push('runtimeRoot: expected a POSIX path such as ~/.local/share/wsl-web-shell');
  }
  if (patch.openOnLaunch !== undefined) {
    if (typeof patch.openOnLaunch === 'boolean') next.openOnLaunch = patch.openOnLaunch;
    else errors.push('openOnLaunch: expected a boolean');
  }
  if (patch.autoRestart !== undefined) {
    if (typeof patch.autoRestart === 'boolean') next.autoRestart = patch.autoRestart;
    else errors.push('autoRestart: expected a boolean');
  }
  if (patch.maxRestartAttempts !== undefined) {
    const value = patch.maxRestartAttempts;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 20) {
      next.maxRestartAttempts = value;
    } else {
      errors.push('maxRestartAttempts: expected an integer between 0 and 20');
    }
  }

  const changed = (Object.keys(next) as (keyof AppConfig)[]).some((key) => next[key] !== current[key]);
  return { config: next, errors, changed };
}

/** Settings that require a backend restart when changed. */
export function requiresRestart(previous: AppConfig, next: AppConfig): boolean {
  return (
    previous.distro !== next.distro ||
    previous.port !== next.port ||
    previous.workspace !== next.workspace ||
    previous.dshPath !== next.dshPath ||
    previous.isolateEnvironment !== next.isolateEnvironment ||
    previous.runtimeRoot !== next.runtimeRoot
  );
}
