/**
 * Persistent record of the backend the owner runs outside this app.
 *
 * A listener that passes the attach checks (own `dsh web` command line inside
 * the distribution plus a working session cookie) is remembered here, so the
 * next launch knows that this port belongs to someone else and must be waited
 * for instead of fought over. The record is a *hint*, never a proof: every
 * attach still re-verifies the PID and the session, and the file lives in the
 * app profile only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ExternalBackendExpectation {
  distro: string;
  port: number;
  /** ISO timestamp of the attach that produced this expectation. */
  recordedAt: string;
  /**
   * Consecutive starts where the launcher was waited for and never appeared.
   * After a few misses the expectation is dropped instead of costing a wait on
   * every boot.
   */
  misses?: number;
}

export interface ExternalBackendStore {
  read(): ExternalBackendExpectation | null;
  write(expectation: ExternalBackendExpectation): void;
  clear(): void;
  path(): string;
}

/** Accept only a complete, plausible record; anything else is ignored. */
export function parseExternalExpectation(value: unknown): ExternalBackendExpectation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const distro = record.distro;
  const port = record.port;
  const recordedAt = record.recordedAt;
  if (typeof distro !== 'string' || distro.trim() === '') return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof recordedAt !== 'string') return null;
  const misses = record.misses;
  if (misses !== undefined && (typeof misses !== 'number' || !Number.isInteger(misses) || misses < 0)) return null;
  return misses === undefined ? { distro, port, recordedAt } : { distro, port, recordedAt, misses };
}

export function createFileExternalStore(filePath: string): ExternalBackendStore {
  return {
    path: () => filePath,
    read() {
      try {
        const raw = readFileSync(filePath, 'utf8');
        return parseExternalExpectation(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    write(expectation) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(expectation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, filePath);
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // A stale expectation only costs one bounded wait on the next start.
      }
    },
  };
}

export function createMemoryExternalStore(initial: ExternalBackendExpectation | null = null): ExternalBackendStore {
  let current = initial;
  return {
    path: () => 'memory',
    read: () => current,
    write: (expectation) => {
      current = expectation;
    },
    clear: () => {
      current = null;
    },
  };
}
