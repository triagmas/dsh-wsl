/**
 * Persistent record of the backend this app owns.
 *
 * The file lives in the app profile (`userData`), never in the user's Windows
 * DeepSeek Harness installation or in the Linux home. It lets a restarted app
 * recognise its own live server instead of starting a duplicate.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseOwnedServerRecord, type OwnedServerRecord } from './ownership.js';

export interface RegistryStore {
  read(): OwnedServerRecord | null;
  write(record: OwnedServerRecord): void;
  clear(): void;
  path(): string;
}

export function createFileRegistry(filePath: string): RegistryStore {
  return {
    path: () => filePath,
    read() {
      try {
        const raw = readFileSync(filePath, 'utf8');
        return parseOwnedServerRecord(JSON.parse(raw) as unknown);
      } catch {
        return null;
      }
    },
    write(record) {
      mkdirSync(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, filePath);
    },
    clear() {
      try {
        rmSync(filePath, { force: true });
      } catch {
        // A stale record is harmless: PID and start time checks reject it.
      }
    },
  };
}

export function createMemoryRegistry(initial: OwnedServerRecord | null = null): RegistryStore {
  let current = initial;
  return {
    path: () => 'memory',
    read: () => current,
    write: (record) => {
      current = record;
    },
    clear: () => {
      current = null;
    },
  };
}
