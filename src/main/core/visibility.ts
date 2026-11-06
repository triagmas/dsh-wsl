/**
 * Window/tray visibility policy (pure).
 *
 * Two rules matter for a tray application:
 *  - a user-hidden window stays hidden, even when the backend becomes ready;
 *  - the always-on-top splash must never pop over the desktop while the app is
 *    hidden — it is shown only when the user opens the app.
 */
import type { LifecycleState } from '../../shared/types.js';

export interface ReadyVisibilityInput {
  /** Config flag: show the window once the WebUI is ready. */
  openOnLaunch: boolean;
  /** True when the window has already been shown at least once this session. */
  everShown: boolean;
  /** True when the window is visible right now. */
  visible: boolean;
}

export type ReadyVisibility = 'show' | 'keep-hidden';

/** Decide what a READY transition may do to the window. */
export function decideReadyVisibility(input: ReadyVisibilityInput): ReadyVisibility {
  if (input.visible) return 'keep-hidden';
  // First successful start honours the setting; afterwards the user owns it.
  if (!input.everShown && input.openOnLaunch) return 'show';
  return 'keep-hidden';
}

/** A recovery/error overlay may only take focus when the window is on screen. */
export function shouldActivateSplash(visible: boolean): boolean {
  return visible;
}

export type TrayOpenAction = 'overlay' | 'window';

/** Tray "Open": there is nothing loadable while recovering or failed. */
export function decideTrayOpen(state: LifecycleState): TrayOpenAction {
  return state === 'ERROR' || state === 'RECOVERING' || state === 'QUITTING' ? 'overlay' : 'window';
}
