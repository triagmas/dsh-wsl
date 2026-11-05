/** System tray integration: menu, tooltip and the "window is hidden" lifetime. */
import { Menu, Tray, nativeImage } from 'electron';
import { existsSync } from 'node:fs';
import type { ShellStatus } from '../../shared/types.js';
import { buildTrayMenu, trayTooltip, type TrayItemId } from '../core/tray-model.js';

export interface TrayHandlers {
  open(): void;
  status(): void;
  restart(): void;
  settings(): void;
  quit(): void;
}

export interface TrayControllerOptions {
  iconPath: string;
  handlers: TrayHandlers;
  log(message: string): void;
}

export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly options: TrayControllerOptions) {}

  create(): void {
    if (this.tray !== null) return;
    const icon = existsSync(this.options.iconPath)
      ? nativeImage.createFromPath(this.options.iconPath)
      : nativeImage.createEmpty();
    this.tray = new Tray(icon);
    this.tray.setToolTip('WSL Web Shell');
    this.tray.on('click', () => this.options.handlers.open());
    this.tray.on('double-click', () => this.options.handlers.open());
  }

  update(status: ShellStatus, windowVisible: boolean): void {
    if (this.tray === null) return;
    const items = buildTrayMenu(status, { windowVisible });
    const template = items.map((item) => {
      if (item.type === 'separator') return { type: 'separator' as const };
      const handler = this.handlersFor(item.id);
      return {
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        click: () => {
          this.options.log(`tray action: ${item.id}`);
          handler();
        },
      };
    });
    this.tray.setToolTip(trayTooltip(status));
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private handlersFor(id: TrayItemId): () => void {
    switch (id) {
      case 'open':
        return () => this.options.handlers.open();
      case 'status':
        return () => this.options.handlers.status();
      case 'restart':
        return () => this.options.handlers.restart();
      case 'settings':
        return () => this.options.handlers.settings();
      case 'quit':
        return () => this.options.handlers.quit();
      default:
        return () => undefined;
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }
}
