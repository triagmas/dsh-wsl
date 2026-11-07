/**
 * Footer bar model (pure): geometry, connection tone and version labels.
 *
 * The bar is an app-owned surface below the unmodified WebUI. Nothing here
 * touches the remote page; the Electron layer only positions a WebContentsView
 * above the bar and feeds this model into the local chrome page.
 */
import type { LatestVersionInfo, LifecycleState } from '../../shared/types.js';

/** Height of the bar in CSS pixels. Kept in sync with `chrome.css`. */
export const FOOTER_HEIGHT = 32;

export type ConnectionTone = 'ok' | 'warn' | 'error' | 'idle';

export interface ConnectionView {
  tone: ConnectionTone;
  /** Short state word shown next to the dot (`Connected`, `Reconnecting`, …). */
  label: string;
  /** Full accessible sentence, never colour-only. */
  description: string;
  /** `WSL <distro> :<port>` */
  endpoint: string;
}

const STATE_TONES: Record<LifecycleState, ConnectionTone> = {
  CHECKING: 'warn',
  STARTING_WSL: 'warn',
  STARTING_WEB: 'warn',
  CONNECTING: 'warn',
  READY: 'ok',
  HIDDEN_IN_TRAY: 'ok',
  RECOVERING: 'warn',
  ERROR: 'error',
  QUITTING: 'idle',
};

const STATE_LABELS: Record<LifecycleState, string> = {
  CHECKING: 'Checking',
  STARTING_WSL: 'Starting WSL',
  STARTING_WEB: 'Starting backend',
  CONNECTING: 'Connecting',
  READY: 'Connected',
  HIDDEN_IN_TRAY: 'Connected (hidden)',
  RECOVERING: 'Reconnecting',
  ERROR: 'Unavailable',
  QUITTING: 'Shutting down',
};

export interface ConnectionInput {
  state: LifecycleState;
  /** Distribution the backend actually runs in. */
  distro: string;
  /** Port the backend actually listens on. */
  port: number;
}

/** Map a supervisor snapshot to the bar: colour, label and endpoint text. */
export function describeConnection(input: ConnectionInput): ConnectionView {
  const tone = STATE_TONES[input.state];
  const label = STATE_LABELS[input.state];
  const endpoint = `WSL ${input.distro} :${input.port}`;
  return { tone, label, endpoint, description: `${label} — ${endpoint}` };
}

/** `DSH 0.2.1-rc.5`, or `DSH —` while the executable version is unknown. */
export function describeInstalledLabel(installed: string | null): string {
  return installed === null || installed === '' ? 'DSH —' : `DSH ${installed}`;
}

export interface LatestLabel {
  text: string;
  /** True when upstream is newer than the installed executable. */
  updateAvailable: boolean;
  /** True while the first lookup has not completed yet. */
  pending: boolean;
}

/**
 * `GitHub 0.2.2-rc.1` plus an update marker when upstream is strictly newer.
 * An unknown or failed lookup never claims "up to date".
 */
export function describeLatestLabel(
  latest: LatestVersionInfo | null,
  installed: string | null,
  compare: (a: string, b: string) => number,
): LatestLabel {
  if (latest === null) return { text: 'GitHub …', updateAvailable: false, pending: true };
  const newer = installed !== null && compare(latest.version, installed) > 0;
  return { text: `GitHub ${latest.version}`, updateAvailable: newer, pending: false };
}

/** Geometry of the remote WebUI view inside a window's content area. */
export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The WebUI view fills everything above the bar. A window shorter than the bar
 * (possible for a fraction of a second during restore) yields a zero-height view
 * instead of negative bounds, which Electron rejects.
 */
export function computeViewBounds(contentWidth: number, contentHeight: number): ViewBounds {
  const width = Math.max(0, Math.floor(contentWidth));
  const height = Math.max(0, Math.floor(contentHeight) - FOOTER_HEIGHT);
  return { x: 0, y: 0, width, height };
}

export interface PopoverAnchor {
  /** Gear button rect in window content coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Validate an anchor sent by the footer renderer. Anything that is not four
 * finite, plausible numbers is rejected instead of being used as geometry.
 */
export function parsePopoverAnchor(value: unknown): PopoverAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;
  const keys = ['x', 'y', 'width', 'height'] as const;
  for (const key of keys) {
    const part = source[key];
    if (typeof part !== 'number' || !Number.isFinite(part) || Math.abs(part) > 100_000) return null;
  }
  return {
    x: source.x as number,
    y: source.y as number,
    width: source.width as number,
    height: source.height as number,
  };
}

export interface PopoverSize {
  width: number;
  height: number;
}

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoverBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Place the popover above the gear, right-aligned to it and fully inside the
 * display work area. It never covers the bar itself.
 */
export function computePopoverBounds(input: {
  anchor: PopoverAnchor;
  /** Window content origin on screen (top-left). */
  window: { x: number; y: number };
  size: PopoverSize;
  workArea: ScreenRect;
}): PopoverBounds {
  const gap = 6;
  const width = Math.min(input.size.width, input.workArea.width);
  const height = Math.min(input.size.height, input.workArea.height);
  const anchorRight = input.window.x + input.anchor.x + input.anchor.width;
  let x = Math.round(anchorRight - width);
  x = Math.max(input.workArea.x, Math.min(x, input.workArea.x + input.workArea.width - width));
  const anchorTop = input.window.y + input.anchor.y;
  let y = Math.round(anchorTop - height - gap);
  if (y < input.workArea.y) {
    // No room above the gear: fall back to the bar, still inside the screen.
    y = Math.max(input.workArea.y, input.workArea.y + input.workArea.height - height);
  }
  return { x, y, width, height };
}
