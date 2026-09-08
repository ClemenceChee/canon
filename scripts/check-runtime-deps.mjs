#!/usr/bin/env node
/**
 * Gate: runtime modules under src/ may import only `node:` builtins and sibling
 * modules (relative imports). `dependencies` in package.json must stay empty.
 * devDependencies may import anything (this script itself is a dev tool).
 *
 * Exit 0 when clean, 1 otherwise.
 */
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const runtimeDeps = Object.keys(pkg.dependencies ?? {});
if (runtimeDeps.length > 0) {
  console.error(
    `check:runtime-deps: package.json "dependencies" must be empty, found: ${runtimeDeps.join(', ')}`,
  );
  process.exit(1);
}

/** Collect every file under src/ that is part of the runtime build. */
function collectTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...collectTsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

const srcFiles = collectTsFiles(join(root, 'src'));
const offenders = [];

for (const file of srcFiles) {
  const text = readFileSync(file, 'utf8');
  // Strip comments to avoid false positives on specifiers mentioned in prose.
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const seen = new Set();
  const consider = (spec) => {
    if (spec.startsWith('node:')) return;
    if (spec.startsWith('./') || spec.startsWith('../')) return;
    if (spec === 'node') return; // ambient types import, not a runtime dep
    const key = `${file}: ${spec}`;
    if (!seen.has(key)) {
      seen.add(key);
      offenders.push(key);
    }
  };
  // static `import … from 'x'` / `export … from 'x'` forms
  for (const m of stripped.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    consider(m[1]);
  }
  // dynamic `import('x')` / `require('x')` specifiers (QA F3) — also catches
  // `require` even though src/ never uses it, so a regression is gate-red.
  for (const m of stripped.matchAll(/(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    consider(m[1]);
  }
}

if (offenders.length > 0) {
  console.error('check:runtime-deps: non-node/non-relative import(s) in runtime src/:');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log('check:runtime-deps: ok (runtime dependencies empty; src imports node:/relative only)');
