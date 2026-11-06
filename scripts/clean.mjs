import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of ['dist', 'release', 'coverage']) {
  rmSync(join(root, dir), { recursive: true, force: true });
  console.log(`clean: ${dir}`);
}
