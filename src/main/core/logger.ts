/** Minimal file logger with mandatory secret redaction. */
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets } from '../backend/urls.js';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  path(): string;
  tail(maxLines: number): string;
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;

export function createLogger(filePath: string, options: { console?: boolean; level?: LogLevel } = {}): Logger {
  const verbose = options.level === 'debug';
  const write = (level: LogLevel, message: string): void => {
    if (level === 'debug' && !verbose) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redactSecrets(message)}\n`;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      try {
        if (statSync(filePath).size > MAX_LOG_BYTES) truncateSync(filePath, 0);
      } catch {
        // File does not exist yet.
      }
      appendFileSync(filePath, line, 'utf8');
    } catch {
      // Logging must never break the supervisor.
    }
    if (options.console !== false) process.stdout.write(line);
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
    debug: (message) => write('debug', message),
    path: () => filePath,
    tail: (maxLines) => {
      try {
        const content = readFileSync(filePath, 'utf8');
        return content.split('\n').slice(-Math.max(1, maxLines)).join('\n');
      } catch {
        return '';
      }
    },
  };
}

export function createNullLogger(): Logger {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    path: () => '',
    tail: () => '',
  };
}
