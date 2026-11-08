/** Tray menu model (pure) — the platform menu is built from this list. */
import type { ShellStatus } from '../../shared/types.js';

export type TrayItemId = 'open' | 'status' | 'restart' | 'settings' | 'quit';

export type TrayMenuItem =
  | { type: 'normal'; id: TrayItemId; label: string; enabled: boolean }
  | { type: 'separator' };

export const STATUS_LABELS: Record<ShellStatus['state'], string> = {
  CHECKING: 'Checking environment',
  STARTING_WSL: 'Starting WSL',
  STARTING_WEB: 'Starting DeepSeek Harness',
  CONNECTING: 'Connecting',
  READY: 'Connected',
  HIDDEN_IN_TRAY: 'Connected (window hidden)',
  RECOVERING: 'Reconnecting',
  ERROR: 'Unavailable',
  QUITTING: 'Shutting down',
};

export function describeStatus(status: ShellStatus): string {
  const suffix = status.ownedServer ? '' : ' — not managed';
  return `${STATUS_LABELS[status.state]}${suffix}`;
}

export interface TrayMenuOptions {
  windowVisible: boolean;
}

export function buildTrayMenu(status: ShellStatus, options: TrayMenuOptions): TrayMenuItem[] {
  const busy =
    status.state === 'CHECKING' ||
    status.state === 'STARTING_WSL' ||
    status.state === 'STARTING_WEB' ||
    status.state === 'CONNECTING' ||
    status.state === 'RECOVERING';
  return [
    { id: 'open', label: options.windowVisible ? 'Focus window' : 'Open', enabled: status.state !== 'QUITTING', type: 'normal' },
    { id: 'status', label: `Status: ${describeStatus(status)}`, enabled: false, type: 'normal' },
    { type: 'separator' },
    {
      id: 'restart',
      label: status.state === 'ERROR' ? 'Retry' : 'Restart WebUI',
      // Restart and retry only ever apply to a backend this app started.
      enabled: status.state === 'ERROR' ? true : status.ownedServer && !busy && status.state !== 'QUITTING',
      type: 'normal',
    },
    { id: 'settings', label: 'Settings…', enabled: status.state !== 'QUITTING', type: 'normal' },
    { type: 'separator' },
    { id: 'quit', label: 'Quit', enabled: status.state !== 'QUITTING', type: 'normal' },
  ];
}

export function trayTooltip(status: ShellStatus): string {
  return `DSH WSL — ${describeStatus(status)}`;
}
