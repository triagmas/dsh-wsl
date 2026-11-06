/** Persistence of the app-owned configuration file in the app profile. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeConfig } from '../core/config.js';
import type { AppConfig } from '../../shared/types.js';

export interface ConfigStore {
  load(): AppConfig;
  save(config: AppConfig): void;
  path(): string;
}

export function createConfigStore(filePath: string): ConfigStore {
  let cached: AppConfig | null = null;
  return {
    path: () => filePath,
    load() {
      if (cached !== null) return cached;
      try {
        cached = normalizeConfig(JSON.parse(readFileSync(filePath, 'utf8')) as unknown);
      } catch {
        cached = normalizeConfig(null);
      }
      return cached;
    },
    save(config) {
      cached = config;
      mkdirSync(dirname(filePath), { recursive: true });
      const temp = `${filePath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
      renameSync(temp, filePath);
    },
  };
}
