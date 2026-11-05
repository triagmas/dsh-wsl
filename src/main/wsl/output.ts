/** Decoding and parsing helpers for `wsl.exe` and backend output. */
import { PID_MARKER } from './args.js';

/**
 * `wsl.exe` writes UTF-16LE. Detect it by looking for the NUL pattern that
 * UTF-16 ASCII produces, then decode accordingly.
 */
export function decodeWslOutput(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  let nulCount = 0;
  for (const byte of buffer) if (byte === 0) nulCount += 1;
  const text = nulCount * 4 >= buffer.length ? buffer.toString('utf16le') : buffer.toString('utf8');
  return text.replace(/^\uFEFF/, '');
}

/** Installed distribution names, tolerant of the `*` default marker. */
export function parseDistroList(text: string): string[] {
  const names: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.replace(/\0/g, '').trim();
    if (line === '') continue;
    if (line.startsWith('*')) line = line.slice(1).trim();
    if (line === '' || /^NAME$/i.test(line)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(line)) continue;
    if (!names.includes(line)) names.push(line);
  }
  return names;
}

/** PID announcement printed by the start wrapper, if already observed. */
export function parsePidMarker(text: string): number | null {
  const pattern = new RegExp(`${PID_MARKER}\\s+(\\d+)`);
  const match = pattern.exec(text);
  if (match === null) return null;
  const pid = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

export interface ProcessProbe {
  startTime: string;
  argv: string[];
  cmdline: string;
}

/** Parse the output of `PROBE_PROCESS_SCRIPT`. */
export function parseProcessProbe(text: string): ProcessProbe | null {
  const startMatch = /starttime=(\d+)/.exec(text);
  const cmdMatch = /cmdline=([\s\S]*?)\s*$/m.exec(text);
  if (startMatch === null || cmdMatch === null) return null;
  const cmdline = (cmdMatch[1] ?? '').trim();
  return { startTime: startMatch[1] ?? '', cmdline, argv: cmdline.split(' ').filter(Boolean) };
}

/** Strip ANSI escapes so captured backend output stays readable and matchable. */
export function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
}

/** Incremental newline splitter for streamed child-process output. */
export class LineBuffer {
  private pending = '';

  constructor(private readonly maxLength = 8192) {}

  push(chunk: string): string[] {
    this.pending += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    if (this.pending.length > this.maxLength) this.pending = this.pending.slice(-this.maxLength);
    return lines;
  }

  flush(): string[] {
    const rest = this.pending;
    this.pending = '';
    return rest === '' ? [] : [rest];
  }
}
