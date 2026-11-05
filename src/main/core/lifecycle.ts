/**
 * Explicit lifecycle state machine (`docs/spec.md`).
 *
 * Transitions are validated against an allowlist, mirrored in a status
 * snapshot and broadcast to subscribers. The machine itself is synchronous;
 * callers serialize long-running work around it.
 */
import type { LifecycleState } from '../../shared/types.js';

const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  CHECKING: ['STARTING_WSL', 'STARTING_WEB', 'ERROR', 'QUITTING'],
  STARTING_WSL: ['STARTING_WEB', 'CONNECTING', 'ERROR', 'QUITTING'],
  STARTING_WEB: ['CONNECTING', 'RECOVERING', 'ERROR', 'QUITTING'],
  CONNECTING: ['STARTING_WEB', 'READY', 'RECOVERING', 'ERROR', 'QUITTING'],
  READY: ['HIDDEN_IN_TRAY', 'RECOVERING', 'ERROR', 'QUITTING', 'CHECKING'],
  HIDDEN_IN_TRAY: ['CHECKING', 'READY', 'RECOVERING', 'ERROR', 'QUITTING'],
  RECOVERING: ['CHECKING', 'STARTING_WSL', 'STARTING_WEB', 'CONNECTING', 'READY', 'ERROR', 'QUITTING', 'HIDDEN_IN_TRAY'],
  ERROR: ['CHECKING', 'STARTING_WSL', 'STARTING_WEB', 'QUITTING', 'RECOVERING'],
  QUITTING: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: LifecycleState, to: LifecycleState) {
    super(`invalid lifecycle transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type StateListener = (state: LifecycleState, previous: LifecycleState) => void;

export class Lifecycle {
  private current: LifecycleState = 'CHECKING';
  private readonly listeners = new Set<StateListener>();

  get state(): LifecycleState {
    return this.current;
  }

  get isTerminal(): boolean {
    return this.current === 'QUITTING';
  }

  /** Idempotent transition: repeating the same state is a no-op, not an error. */
  transition(to: LifecycleState): boolean {
    if (to === this.current) return false;
    if (!canTransition(this.current, to)) throw new InvalidTransitionError(this.current, to);
    const previous = this.current;
    this.current = to;
    for (const listener of this.listeners) listener(to, previous);
    return true;
  }

  /** Force the terminal state during shutdown, bypassing normal guards. */
  forceQuit(): void {
    if (this.current === 'QUITTING') return;
    const previous = this.current;
    this.current = 'QUITTING';
    for (const listener of this.listeners) listener('QUITTING', previous);
  }

  onChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
}

/** Bounded exponential backoff used between restart attempts. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 1_000;
  const factor = options.factor ?? 2;
  const maxMs = options.maxMs ?? 8_000;
  const safeAttempt = Math.max(0, Math.min(attempt, 16));
  return Math.min(maxMs, baseMs * factor ** safeAttempt);
}
