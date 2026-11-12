/**
 * Navigation / popup / permission policy for the embedded WebUI.
 *
 * The window has no address bar and no tabs: the only loadable document is the
 * configured loopback origin. External HTTPS links may leave to the system
 * browser, but never localhost, LAN or literal IP targets.
 */
import { isAllowedNavigation, isSafeExternalUrl } from '../backend/urls.js';

export type NavigationDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'external'; url: string }
  | { action: 'external-blocked'; reason: string };

export interface NavigationContext {
  url: string;
  origin: string;
  isMainFrame: boolean;
  isUserInitiated: boolean;
}

export function decideNavigation(context: NavigationContext): NavigationDecision {
  if (isAllowedNavigation(context.url, context.origin)) return { action: 'allow' };

  let parsed: URL;
  try {
    parsed = new URL(context.url);
  } catch {
    return { action: 'block', reason: 'malformed-url' };
  }

  if (parsed.protocol === 'https:') {
    if (!context.isUserInitiated) return { action: 'external-blocked', reason: 'not-user-initiated' };
    if (!isSafeExternalUrl(context.url)) return { action: 'external-blocked', reason: 'unsafe-external-target' };
    return { action: 'external', url: context.url };
  }

  return { action: 'block', reason: `unsupported-scheme:${parsed.protocol.replace(':', '')}` };
}

/** `window.open` / target=_blank: popups are always denied, safe links leave. */
export function decideWindowOpen(url: string, origin: string): NavigationDecision {
  if (isAllowedNavigation(url, origin)) return { action: 'block', reason: 'popup-not-allowed' };
  if (isSafeExternalUrl(url)) return { action: 'external', url };
  return { action: 'block', reason: 'popup-not-allowed' };
}

/** Minimum time between two hand-offs to the system browser. */
export const EXTERNAL_HANDOFF_COOLDOWN_MS = 1500;

export interface ExternalHandoffContext {
  /** The app window that asked to open the link is focused (and therefore visible). */
  focused: boolean;
  /** When the previous hand-off happened; 0 means "never". */
  lastHandoffAt: number;
  now: number;
}

export type ExternalHandoffDecision =
  | { action: 'open' }
  | { action: 'block'; reason: 'window-not-focused' | 'too-frequent' };

/**
 * Gate for handing a URL to the system browser.
 *
 * Electron 45 exposes no user-gesture flag on `setWindowOpenHandler` and its
 * `disposition` is 'foreground-tab' both for a clicked `target=_blank` link and
 * for a bare `window.open()` call (verified against the shipped Electron), so a
 * gesture check cannot be spelled out in code. What can be enforced: the request
 * must come from the app window the user is actually looking at, and requests
 * are rate-limited, so remote content cannot silently spray the OS browser.
 */
export function decideExternalHandoff(context: ExternalHandoffContext): ExternalHandoffDecision {
  if (!context.focused) return { action: 'block', reason: 'window-not-focused' };
  if (
    context.lastHandoffAt !== 0 &&
    context.now - context.lastHandoffAt < EXTERNAL_HANDOFF_COOLDOWN_MS
  ) {
    return { action: 'block', reason: 'too-frequent' };
  }
  return { action: 'open' };
}

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/**
 * Permission requests come from backend content, so the allowlist is tiny:
 * fullscreen and sanitized clipboard writes. Camera, microphone, geolocation,
 * notifications and device access stay denied.
 */
export function decidePermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}
