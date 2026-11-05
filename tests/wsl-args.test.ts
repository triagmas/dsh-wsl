import { describe, expect, it } from 'vitest';
import {
  ArgumentError,
  PROBE_PROCESS_SCRIPT,
  RESOLVE_DSH_SCRIPT,
  START_WRAPPER_SCRIPT,
  buildDshPathCheckArgs,
  buildListDistrosArgs,
  buildProbeProcessArgs,
  buildResolveDshArgs,
  buildSignalArgs,
  buildStartServerArgs,
} from '../src/main/wsl/args.js';
import {
  LineBuffer,
  decodeWslOutput,
  parseDistroList,
  parsePidMarker,
  parseProcessProbe,
  stripAnsi,
} from '../src/main/wsl/output.js';

describe('start command construction', () => {
  const base = { distro: 'Ubuntu', dshPath: '/usr/local/bin/dsh', port: 3080, workspace: '~' };

  it('uses an argument array with no shell interpolation of values', () => {
    const argv = buildStartServerArgs(base);
    expect(argv).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '~',
      '--exec',
      '/bin/bash',
      '-c',
      START_WRAPPER_SCRIPT,
      '/usr/local/bin/dsh',
      '127.0.0.1',
      '3080',
    ]);
    // Per-launch values never appear inside the script text.
    expect(START_WRAPPER_SCRIPT).not.toContain('3080');
    expect(START_WRAPPER_SCRIPT).not.toContain('Ubuntu');
    expect(START_WRAPPER_SCRIPT).not.toContain('/usr/local/bin/dsh');
  });

  it('binds loopback only and always disables the server-side browser handoff', () => {
    const argv = buildStartServerArgs(base);
    expect(argv).toContain('127.0.0.1');
    expect(START_WRAPPER_SCRIPT).toContain('--no-open');
    expect(() => buildStartServerArgs({ ...base, host: '0.0.0.0' })).toThrow(ArgumentError);
  });

  it('rejects an injectable distribution name', () => {
    for (const distro of ['Ubuntu; rm -rf /', 'Ubuntu\n--help', '-Ubuntu', '']) {
      expect(() => buildStartServerArgs({ ...base, distro })).toThrow(ArgumentError);
    }
  });

  it('rejects invalid ports', () => {
    for (const port of [0, 80, 1023, 65536, 3.5, Number.NaN]) {
      expect(() => buildStartServerArgs({ ...base, port })).toThrow(ArgumentError);
    }
  });

  it('rejects unsafe workspace and executable paths', () => {
    for (const workspace of ['C:\\Users\\me', '/home/me\nrm -rf /', 'relative/path', '']) {
      expect(() => buildStartServerArgs({ ...base, workspace })).toThrow(ArgumentError);
    }
    for (const dshPath of ['dsh', '/usr/bin/../bin/dsh', '/usr/bin/dsh\n']) {
      expect(() => buildStartServerArgs({ ...base, dshPath })).toThrow(ArgumentError);
    }
  });

  it('keeps diagnostic helpers read-only', () => {
    expect(buildListDistrosArgs()).toEqual(['-l', '-q']);
    expect(buildResolveDshArgs('Ubuntu')).toEqual(['-d', 'Ubuntu', '--exec', '/bin/sh', '-c', RESOLVE_DSH_SCRIPT]);
    expect(RESOLVE_DSH_SCRIPT).not.toMatch(/\b(apt|npm i|pnpm|curl|wget)\b/);
    expect(buildDshPathCheckArgs('Ubuntu', '/tmp/dsh')).toContain('/bin/test');
    expect(buildProbeProcessArgs('Ubuntu', 42)).toContain(PROBE_PROCESS_SCRIPT);
    expect(buildProbeProcessArgs('Ubuntu', 42).at(-1)).toBe('42');
    expect(buildSignalArgs('Ubuntu', 42, 'TERM').at(-1)).toBe('42');
    expect(buildSignalArgs('Ubuntu', 42, 'TERM').join(' ')).toContain('kill -s TERM');
    // Only signals for a single validated PID; never a group or a distro-wide stop.
    const all = [...buildSignalArgs('Ubuntu', 42, 'KILL'), ...buildStartServerArgs(base)].join(' ');
    expect(all).not.toMatch(/--shutdown|taskkill|pkill|killall|kill -\d/);
  });
});

describe('wsl output decoding', () => {
  it('decodes UTF-16LE output from wsl.exe', () => {
    const text = 'Ubuntu\r\nDebian\r\n';
    const buffer = Buffer.from(text, 'utf16le');
    expect(decodeWslOutput(buffer)).toBe(text);
  });

  it('decodes UTF-8 output unchanged', () => {
    expect(decodeWslOutput(Buffer.from('Ubuntu\n', 'utf8'))).toBe('Ubuntu\n');
  });

  it('parses distribution lists tolerant of markers and noise', () => {
    expect(parseDistroList('Ubuntu\r\n* docker-desktop\r\n\r\nDebian\r\n')).toEqual([
      'Ubuntu',
      'docker-desktop',
      'Debian',
    ]);
    expect(parseDistroList('\uFEFFUbuntu\r\n')).toEqual(['Ubuntu']);
  });

  it('parses the pid announcement', () => {
    expect(parsePidMarker('__dsh_web_shell_pid__ 1234')).toBe(1234);
    expect(parsePidMarker('dsh web: http://127.0.0.1:3080/?token=x')).toBeNull();
  });

  it('parses /proc probe output', () => {
    const probe = parseProcessProbe(
      'starttime=918273\ncmdline=/usr/bin/node /usr/local/bin/dsh web --host 127.0.0.1 --port 3080 --no-open \n',
    );
    expect(probe).not.toBeNull();
    expect(probe?.startTime).toBe('918273');
    expect(probe?.argv).toContain('--port');
    expect(parseProcessProbe('garbage')).toBeNull();
  });

  it('strips ANSI escapes', () => {
    expect(stripAnsi('\u001B[32mdsh web:\u001B[0m ok')).toBe('dsh web: ok');
  });

  it('reassembles split lines without losing data', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('dsh web: http://127.0.0.1:30')).toEqual([]);
    expect(buffer.push('80/?token=abc\r\nnext')).toEqual(['dsh web: http://127.0.0.1:3080/?token=abc']);
    expect(buffer.flush()).toEqual(['next']);
  });
});
