import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileExternalStore,
  createMemoryExternalStore,
  parseExternalExpectation,
} from '../src/main/core/external.js';

const scratch: string[] = [];

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), 'wsl-web-shell-external-'));
  scratch.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const valid = { distro: 'Ubuntu', port: 3080, recordedAt: '2026-01-01T00:00:00.000Z' };

describe('external backend expectation', () => {
  it('accepts a complete record', () => {
    expect(parseExternalExpectation(valid)).toEqual(valid);
  });

  it.each([
    ['not an object', 'nope'],
    ['missing distro', { port: 3080, recordedAt: valid.recordedAt }],
    ['blank distro', { ...valid, distro: '  ' }],
    ['port out of range', { ...valid, port: 70000 }],
    ['fractional port', { ...valid, port: 3080.5 }],
    ['missing timestamp', { distro: 'Ubuntu', port: 3080 }],
  ])('ignores a record with %s', (_label, value) => {
    expect(parseExternalExpectation(value)).toBeNull();
  });

  it('round-trips through the profile file and clears it', () => {
    const file = join(tempDir(), 'external-backend.json');
    const store = createFileExternalStore(file);

    expect(store.read()).toBeNull();
    store.write(valid);
    expect(store.read()).toEqual(valid);
    // The record is a hint, so a corrupt file must not break the next launch.
    writeFileSync(file, '{ not json', 'utf8');
    expect(store.read()).toBeNull();
    store.write(valid);
    store.clear();
    expect(store.read()).toBeNull();
  });

  it('stores the record as readable JSON with the recorded port', () => {
    const file = join(tempDir(), 'external-backend.json');
    createFileExternalStore(file).write(valid);

    expect(JSON.parse(readFileSync(file, 'utf8')) as unknown).toEqual(valid);
  });

  it('keeps the in-memory store independent of the file', () => {
    const store = createMemoryExternalStore();
    expect(store.read()).toBeNull();
    store.write(valid);
    expect(store.read()).toEqual(valid);
    store.clear();
    expect(store.read()).toBeNull();
  });
});
