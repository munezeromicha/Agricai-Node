/**
 * No transpile step — this API runs as ESM. `npm run build` syntax-checks src/
 * so CI/hosting that always invoke `build` still have a real gate.
 */
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

async function walk(dir) {
  const files = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await walk(path)));
    else if (extname(ent.name) === '.mjs') files.push(path);
  }
  return files;
}

const files = await walk(srcDir);
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `${file} failed\n`);
  }
}

if (failed) process.exit(1);
console.log(`Checked ${files.length} modules — no compile step required.`);
