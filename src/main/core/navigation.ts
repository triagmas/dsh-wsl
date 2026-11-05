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

const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write']);

/**
 * Permission requests come from backend content, so the allowlist is tiny:
 * fullscreen and sanitized clipboard writes. Camera, microphone, geolocation,
 * notifications and device access stay denied.
 */
export function decidePermission(permission: string): boolean {
  return ALLOWED_PERMISSIONS.has(permission);
}
