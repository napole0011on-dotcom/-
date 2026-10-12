// pnpm test:e2e — runs every e2e/*.e2e.mjs against the running panel, one after another.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = import.meta.dirname;
const only = process.argv[2];
for (const f of readdirSync(dir)
  .filter((x) => x.endsWith('.e2e.mjs'))
  .sort()) {
  if (only && !f.includes(only)) continue;
  console.log(`\n▶ ${f}`);
  await import(pathToFileURL(path.join(dir, f)).href);
}
