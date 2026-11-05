/** Minimal, explicit bridge for the app-owned splash window. */
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellStatus } from '../shared/types.js';

const api = {
  onStatus(listener: (status: ShellStatus) => void): void {
    ipcRenderer.on('shell:status', (_event, status: ShellStatus) => listener(status));
  },
  requestStatus(): Promise<ShellStatus> {
    return ipcRenderer.invoke('shell:status:get') as Promise<ShellStatus>;
  },
  retry(): Promise<void> {
    return ipcRenderer.invoke('shell:retry') as Promise<void>;
  },
  openLogs(): Promise<void> {
    return ipcRenderer.invoke('shell:open-logs') as Promise<void>;
  },
  quit(): Promise<void> {
    return ipcRenderer.invoke('shell:quit') as Promise<void>;
  },
};

contextBridge.exposeInMainWorld('shell', api);

export type SplashBridge = typeof api;
