/**
 * Backend process ownership.
 *
 * A server counts as app-owned only when a recorded Linux PID is still alive,
 * still has the same `/proc/<pid>/stat` start time (no PID reuse) and its
 * command line still is our `dsh web --host 127.0.0.1 --port <port>` launch.
 * Port reachability alone never grants ownership.
 */
import type { ProcessProbe } from '../wsl/output.js';

export interface OwnedServerRecord {
  presetId: string;
  distro: string;
  port: number;
  pid: number;
  /** `/proc/<pid>/stat` field 22 at launch time. */
  startTime: string;
  workspace: string;
  startedAt: string;
  appVersion: string;
}

export type OwnershipVerdict = 'owned' | 'foreign' | 'gone';

export interface OwnershipExpectation {
  port: number;
  startTime?: string | null;
  host?: string;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Validate a persisted record; anything malformed is treated as absent. */
export function parseOwnedServerRecord(value: unknown): OwnedServerRecord | null {
  if (!isRecordLike(value)) return null;
  const { presetId, distro, port, pid, startTime, workspace, startedAt, appVersion } = value;
  if (typeof presetId !== 'string' || presetId === '') return null;
  if (typeof distro !== 'string' || distro === '') return null;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) return null;
  if (!Number.isInteger(pid) || (pid as number) <= 1) return null;
  if (typeof startTime !== 'string' || !/^\d+$/.test(startTime)) return null;
  if (typeof workspace !== 'string') return null;
  if (typeof startedAt !== 'string') return null;
  if (typeof appVersion !== 'string') return null;
  return { presetId, distro, port: port as number, pid: pid as number, startTime, workspace, startedAt, appVersion };
}

/** Does this command line look like our own `dsh web` launch? */
export function looksLikeOurBackend(probe: ProcessProbe, expectation: OwnershipExpectation): boolean {
  const host = expectation.host ?? '127.0.0.1';
  const argv = probe.argv;
  if (argv.length === 0) return false;
  // Any real `dsh` launch carries the CLI name somewhere in its command line
  // (path, script, or package). Combined with profile, host and port this is
  // specific enough, and the start-time check defeats PID reuse.
  if (!probe.cmdline.includes('dsh')) return false;
  const hasProfile = argv.includes('web');
  const portIndex = argv.indexOf('--port');
  const hostIndex = argv.indexOf('--host');
  const portOk = portIndex >= 0 && argv[portIndex + 1] === String(expectation.port);
  const hostOk = hostIndex >= 0 && argv[hostIndex + 1] === host;
  return hasProfile && portOk && hostOk;
}

export function verifyOwnership(probe: ProcessProbe | null, expectation: OwnershipExpectation): OwnershipVerdict {
  if (probe === null) return 'gone';
  if (probe.startTime === '') return 'gone';
  if (expectation.startTime != null && probe.startTime !== expectation.startTime) return 'gone';
  return looksLikeOurBackend(probe, expectation) ? 'owned' : 'foreign';
}
