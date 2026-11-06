/**
 * Bridge for the compact settings popover.
 *
 * Same IPC channels and therefore the same main-process validation as the full
 * settings window; only "close" and "open the full window" differ.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { AppConfig, ConfigPatch, ShellStatus } from '../shared/types.js';

export interface PopoverSnapshot {
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
  load(): Promise<PopoverSnapshot> {
    return ipcRenderer.invoke('settings:load') as Promise<PopoverSnapshot>;
  },
  save(patch: ConfigPatch): Promise<SaveResult> {
    return ipcRenderer.invoke('settings:save', patch) as Promise<SaveResult>;
  },
  listDistros(): Promise<string[]> {
    return ipcRenderer.invoke('settings:distros') as Promise<string[]>;
  },
  openFullSettings(): Promise<void> {
    return ipcRenderer.invoke('settings:open-window') as Promise<void>;
  },
  close(): Promise<void> {
    return ipcRenderer.invoke('popover:close') as Promise<void>;
  },
  onStatus(listener: (status: ShellStatus) => void): void {
    ipcRenderer.on('shell:status', (_event, status: ShellStatus) => listener(status));
  },
};

contextBridge.exposeInMainWorld('popover', api);

export type PopoverBridge = typeof api;
