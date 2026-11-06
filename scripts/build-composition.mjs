/**
 * Build the composition harness bundle (development only).
 *
 * `npm run composition:smoke` needs the real `Windows` class, but the app entry
 * bundle intentionally exports nothing. This produces one extra CommonJS file in
 * `dist/test/` for the harness, with Electron left external so the harness runs
 * inside the real runtime. The file is not part of the packaged application
 * (electron-builder only ships `dist/**` minus `dist/test/**`).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  stdin: {
    contents: `
      export { Windows, PARTITION } from '../src/main/electron/windows.js';
      export { FOOTER_HEIGHT, computeViewBounds } from '../src/main/core/footer.js';
      export { createNullLogger } from '../src/main/core/logger.js';
    `,
    resolveDir: join(root, 'scripts'),
    sourcefile: 'composition-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
  external: ['electron'],
  outfile: join(root, 'dist', 'test', 'composition.cjs'),
});

console.log('composition harness bundle: dist/test/composition.cjs');
