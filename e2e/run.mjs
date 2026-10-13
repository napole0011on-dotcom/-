// pnpm test:e2e — runs e2e/*.e2e.mjs against the running panel, one after another: «team»
// first (it starts from an empty board), then the rest. «worker» needs the bot stopped, so it
// runs only by name: pnpm test:e2e worker.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const dir = import.meta.dirname;
const only = process.argv[2];
const files = readdirSync(dir)
  .filter((x) => x.endsWith('.e2e.mjs'))
  .sort(
    (a, b) => Number(b.startsWith('team')) - Number(a.startsWith('team')) || a.localeCompare(b),
  );
for (const f of files) {
  if (only ? !f.includes(only) : f.startsWith('worker')) continue;
  console.log(`\n▶ ${f}`);
  await import(pathToFileURL(path.join(dir, f)).href);
}
