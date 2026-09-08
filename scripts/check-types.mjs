#!/usr/bin/env node
/**
 * Gate (DEC-9): the published library types are a shipped contract —
 * package.json `exports.types` must resolve to a real emitted declaration
 * file (and the runtime `exports.import` entry must exist too). Runs after
 * `npm run build` (tsup `dts: true` emits dist/index.d.ts).
 *
 * Exit 0 when the declared artifacts exist, 1 otherwise.
 */
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(
  await import('node:fs/promises').then((fs) => fs.readFile(join(root, 'package.json'), 'utf8')),
);

const exportsEntry = pkg.exports?.['.'];
const typesSpec = exportsEntry?.types;
const importSpec = exportsEntry?.import;

if (typeof typesSpec !== 'string' || typeof importSpec !== 'string') {
  console.error(
    'check:types: package.json exports["."] must declare both "types" and "import" strings',
  );
  process.exit(1);
}

const typesPath = resolve(root, typesSpec);
const importPath = resolve(root, importSpec);

if (!existsSync(typesPath)) {
  console.error(
    `check:types: declared types entry ${JSON.stringify(typesSpec)} does not exist (${typesPath}). ` +
      'Run npm run build (tsup dts:true must emit the declaration file).',
  );
  process.exit(1);
}
if (!existsSync(importPath)) {
  console.error(`check:types: declared import entry ${JSON.stringify(importSpec)} does not exist`);
  process.exit(1);
}

console.log(`check:types: ok (exports.types -> ${typesSpec}; exports.import -> ${importSpec})`);
