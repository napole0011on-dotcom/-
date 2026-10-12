// Fails when a color value is written anywhere in the panel sources except the token file.
// Colors must come from apps/web/src/theme/tokens.css (CSS variables).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'apps', 'web', 'src');
const allowed = new Set([path.join(root, 'theme', 'tokens.css')]);
const pattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/;
const problems = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(css|tsx?|html)$/.test(name) && !allowed.has(file)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // ignore comments and URL fragments like "#/$defs"
          const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
          if (pattern.test(code) && !/href=|#\/|id=/.test(code))
            problems.push(`${path.relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        });
    }
  }
}
walk(root);
if (problems.length) {
  console.error('Hard-coded colors outside apps/web/src/theme/tokens.css:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('check-colors: ok');
