import { describe, expect, it } from 'vitest';
import {
  parseOwnedServerRecord,
  verifyOwnership,
  type OwnedServerRecord,
} from '../src/main/core/ownership.js';
import { createMemoryRegistry } from '../src/main/core/registry.js';
import { backendProbe } from './helpers.js';

const record: OwnedServerRecord = {
  presetId: 'deepseek-harness',
  distro: 'Ubuntu',
  port: 3080,
  pid: 4242,
  startTime: '918273',
  workspace: '~',
  startedAt: '2026-01-01T00:00:00.000Z',
  appVersion: '0.1.0',
};

describe('verifyOwnership', () => {
  it('accepts the recorded process on the configured port', () => {
    expect(verifyOwnership(backendProbe(), { port: 3080, startTime: record.startTime })).toBe('owned');
  });

  it('rejects a recycled PID with a different start time', () => {
    expect(verifyOwnership(backendProbe(), { port: 3080, startTime: '1000' })).toBe('gone');
  });

  it('rejects a backend on a different port', () => {
    expect(verifyOwnership(backendProbe({ port: 3090 }), { port: 3080 })).toBe('foreign');
  });

  it('rejects a non-dsh listener that happens to hold the port', () => {
    const probe = { startTime: '918273', cmdline: '/usr/bin/python3 -m http.server 3080', argv: ['/usr/bin/python3', '-m', 'http.server', '3080'] };
    expect(verifyOwnership(probe, { port: 3080 })).toBe('foreign');
  });

  it('treats a vanished process as gone', () => {
    expect(verifyOwnership(null, { port: 3080 })).toBe('gone');
    expect(verifyOwnership({ startTime: '', cmdline: '', argv: [] }, { port: 3080 })).toBe('gone');
  });
});

describe('persisted record validation', () => {
  it('round-trips a valid record', () => {
    const registry = createMemoryRegistry(record);
    expect(registry.read()).toEqual(record);
    registry.clear();
    expect(registry.read()).toBeNull();
  });

  it('rejects malformed persisted data', () => {
    expect(parseOwnedServerRecord(null)).toBeNull();
    expect(parseOwnedServerRecord({ ...record, pid: 'x' })).toBeNull();
    expect(parseOwnedServerRecord({ ...record, port: 80 })).toBeNull();
    expect(parseOwnedServerRecord({ ...record, startTime: 'abc' })).toBeNull();
    expect(parseOwnedServerRecord({ ...record, pid: 1 })).toBeNull();
  });
});
