/** Loopback port reachability probe (Windows side). */
import { connect } from 'node:net';

export type PortState = 'free' | 'occupied';

/**
 * A refused connection means nothing listens on the loopback port. Anything
 * else (accept, reset, timeout) counts as occupied: the shell then refuses to
 * adopt the unknown listener unless the PID record proves ownership.
 */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<PortState> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const finish = (state: PortState): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('occupied'));
    socket.once('timeout', () => finish('occupied'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ECONNREFUSED' ? 'free' : 'occupied');
    });
  });
}

export type PortSituation = 'free' | 'reuse-owned' | 'collision';

/**
 * Decide what to do with the configured port.
 * Only a verified, app-owned process on the port may be reused; any other
 * listener is a collision that fails closed.
 */
export function classifyPortSituation(
  state: PortState,
  ownership: 'owned' | 'foreign' | 'gone' | 'unknown',
): PortSituation {
  if (state === 'free') return 'free';
  return ownership === 'owned' ? 'reuse-owned' : 'collision';
}
