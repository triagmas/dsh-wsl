/** WebUI client bound to the isolated Electron session partition. */

import type { WebClient } from '../core/supervisor.js';
import type { Logger } from '../core/logger.js';

export interface SessionLike {
  fetch(input: string, init?: Record<string, unknown>): Promise<{ status: number }>;
}

/**
 * `bootstrapToken` sends the tokenized startup URL through one request only:
 * the server answers with the signed session cookie and a redirect to the clean
 * root. The token never reaches the renderer, the history or the address bar.
 */
export function createWebClient(getSession: () => SessionLike, log: Logger): WebClient {
  return {
    async bootstrapToken(tokenUrl) {
      try {
        const response = await getSession().fetch(tokenUrl, {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store',
          credentials: 'include',
        });
        log.info(`startup token exchange status=${response.status}`);
        return response.status;
      } catch (error) {
        log.error(`startup token exchange failed: ${error instanceof Error ? error.name : 'error'}`);
        return 0;
      }
    },

    async health(origin) {
      try {
        const response = await getSession().fetch(`${origin}/`, {
          method: 'GET',
          redirect: 'manual',
          cache: 'no-store',
          credentials: 'include',
        });
        return response.status;
      } catch {
        return 0;
      }
    },
  };
}
