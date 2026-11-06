/**
 * Window/tray visibility policy (pure).
 *
 * A tray application must never put a window over somebody else's desktop:
 *  - a background start, a reconnect and an automated run present no window;
 *  - a manual start shows a loading surface, and a manual tray "Open" brings the
 *    app forward;
 *  - the loading surface is never always-on-top and never takes focus unless the
 *    user asked for it in this very action;
 *  - a user-hidden window stays hidden, even when the backend becomes ready.
 */
import type { LifecycleState } from '../../shared/types.js';

/** How the process was started. */
export type LaunchMode = 'interactive' | 'automation';

export interface LaunchModeInput {
  /** `--automation` or `--quiet` was passed on the command line. */
  flag: boolean;
  /** `WSL_WEB_SHELL_AUTOMATION=1` in the environment. */
  env: boolean;
}

/**
 * Automation mode exists for tests and scheduled runs: no window is created,
 * shown or focused for the whole lifetime of the process.
 */
export function decideLaunchMode(input: LaunchModeInput): LaunchMode {
  return input.flag || input.env ? 'automation' : 'interactive';
}

export interface ReadyVisibilityInput {
  /** Config flag: show the window once the WebUI is ready. */
  openOnLaunch: boolean;
  /** True when the window has already been shown at least once this session. */
  everShown: boolean;
  /** True when the window is visible right now. */
  visible: boolean;
  /** Automation runs never show a window. */
  mode: LaunchMode;
}

export type ReadyVisibility = 'show' | 'keep-hidden';

/** Decide what a READY transition may do to the window. */
export function decideReadyVisibility(input: ReadyVisibilityInput): ReadyVisibility {
  if (input.mode === 'automation') return 'keep-hidden';
  if (input.visible) return 'keep-hidden';
  // First successful start honours the setting; afterwards the user owns it.
  if (!input.everShown && input.openOnLaunch) return 'show';
  return 'keep-hidden';
}

export interface StartupSurfaceInput {
  mode: LaunchMode;
  /** Config flag: this launch is meant to be visible. */
  openOnLaunch: boolean;
}

export type StartupSurface = 'splash' | 'none';

/**
 * A start-up loading surface is shown only when the user started the app to see
 * it. `openOnLaunch: false` is a deliberate background/tray start.
 */
export function decideStartupSurface(input: StartupSurfaceInput): StartupSurface {
  if (input.mode === 'automation') return 'none';
  if (!input.openOnLaunch) return 'none';
  return 'splash';
}

export interface SplashPresentationInput {
  /** `startup` for the initial loading surface, `blocked` for recovery/error. */
  reason: 'startup' | 'blocked';
  mode: LaunchMode;
  /** True when the user performed this action (launch, tray Open). */
  userRequested: boolean;
  /** True when the WebUI window is on screen. */
  mainVisible: boolean;
}

/**
 * `user` - show and focus (the user just asked for the app).
 * `overlay` - show without focus, on top of our own visible window only.
 * `hidden` - keep the overlay out of the way, or do not create it at all.
 */
export type SplashPresentation = 'user' | 'overlay' | 'hidden';

export function decideSplashPresentation(input: SplashPresentationInput): SplashPresentation {
  if (input.mode === 'automation') return 'hidden';
  if (input.userRequested) return 'user';
  // A background reconnect may only draw inside a window the user already sees.
  if (input.mainVisible) return 'overlay';
  return 'hidden';
}

/** Window attributes of the loading surface: never on top of other apps. */
export interface SplashWindowAttributes {
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  focusable: boolean;
}

export function splashWindowAttributes(): SplashWindowAttributes {
  return { alwaysOnTop: false, skipTaskbar: true, focusable: true };
}

export type TrayOpenAction = 'overlay' | 'window';

/** Tray "Open": there is nothing loadable while recovering or failed. */
export function decideTrayOpen(state: LifecycleState): TrayOpenAction {
  return state === 'ERROR' || state === 'RECOVERING' || state === 'QUITTING' ? 'overlay' : 'window';
}
