/**
 * Issue #12 — the transaction journal must be fail-loud (review P0-A).
 *
 * The journal is the only record of a swap, so a write that silently fails would
 * let the updater replace a runtime it could not repair after a crash. These
 * tests use the real file-backed store: a write has to be durable and readable
 * back, and an impossible write has to throw instead of being logged away.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJournalStore } from '../src/main/core/update-recovery.js';
import { createNullLogger } from '../src/main/core/logger.js';
import { parseUpdateJournal, type UpdateJournal } from '../src/main/core/update.js';

const journal = (overrides: Partial<UpdateJournal> = {}): UpdateJournal => ({
  version: 1,
  transaction: '20261107T101500Z-1a2b',
  phase: 'activating',
  distro: 'Ubuntu',
  runtimeRoot: '~/.local/share/wsl-web-shell',
  canonicalRoot: '/home/u/.local/share/wsl-web-shell',
  target: '0.2.2-rc.1',
  installed: '0.2.1-rc.5',
  startedAt: '2026-11-07T10:15:00.000Z',
  updatedAt: '2026-11-07T10:15:04.000Z',
  ...overrides,
});

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'wss-journal-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('journal store', () => {
  it('writes a record that can be read back and parsed', async () => {
    const directory = await scratch();
    const path = join(directory, 'profile', 'update-journal.json');
    const store = createJournalStore(path, createNullLogger());

    store.write(journal());
    expect((await stat(path)).isFile()).toBe(true);
    expect(parseUpdateJournal(JSON.parse(await readFile(path, 'utf8')) as unknown)).toEqual(journal());
    expect(store.read()).toEqual(journal());

    store.clear();
    expect(store.read()).toBeNull();
  });

  it('replaces a previous record atomically', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    const store = createJournalStore(path, createNullLogger());

    store.write(journal({ phase: 'staging' }));
    store.write(journal({ phase: 'activating' }));
    expect(store.read()?.phase).toBe('activating');
    // No temporary file is left behind.
    await expect(stat(`${path}.tmp`)).rejects.toBeTruthy();
  });

  it('throws when the profile cannot be written, instead of ignoring it', async () => {
    const directory = await scratch();
    // A file occupies the profile path, so the directory cannot be created.
    const blocker = join(directory, 'profile');
    await writeFile(blocker, 'not a directory', 'utf8');
    const store = createJournalStore(join(blocker, 'update-journal.json'), createNullLogger());

    expect(() => store.write(journal())).toThrow();
    expect(store.read()).toBeNull();
  });

  it('ignores a corrupt record but reports it', async () => {
    const directory = await scratch();
    const path = join(directory, 'update-journal.json');
    await writeFile(path, '{ not json', 'utf8');
    const messages: string[] = [];
    const store = createJournalStore(path, {
      info: () => undefined,
      warn: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
      debug: () => undefined,
      tail: () => '',
      path: () => path,
    });

    expect(store.read()).toBeNull();
    expect(messages.join(' ')).toContain('could not be read');
  });
});
