// Cross-platform clean (no rm -rf, works on Windows).
import { readdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
for (const group of ['apps', 'packages']) {
  const groupDir = path.join(root, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    for (const target of ['dist', 'tsconfig.tsbuildinfo']) {
      rmSync(path.join(groupDir, name, target), { recursive: true, force: true });
    }
  }
}
console.log('clean: done');
