/** Minimal, explicit bridge for the app-owned settings window. */
import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, ConfigPatch, ShellStatus } from '../shared/types.js';

export interface SettingsSnapshot {
  config: AppConfig;
  distros: string[];
  status: ShellStatus;
  configPath: string;
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
  restartRequired: boolean;
  config: AppConfig;
}

const api = {
  load(): Promise<SettingsSnapshot> {
    return ipcRenderer.invoke('settings:load') as Promise<SettingsSnapshot>;
  },
  save(patch: ConfigPatch): Promise<SaveResult> {
    return ipcRenderer.invoke('settings:save', patch) as Promise<SaveResult>;
  },
  listDistros(): Promise<string[]> {
    return ipcRenderer.invoke('settings:distros') as Promise<string[]>;
  },
  close(): Promise<void> {
    return ipcRenderer.invoke('settings:close') as Promise<void>;
  },
  openConfigFolder(): Promise<void> {
    return ipcRenderer.invoke('settings:open-config') as Promise<void>;
  },
  onStatus(listener: (status: ShellStatus) => void): void {
    ipcRenderer.on('shell:status', (_event, status: ShellStatus) => listener(status));
  },
};

contextBridge.exposeInMainWorld('settings', api);

export type SettingsBridge = typeof api;
