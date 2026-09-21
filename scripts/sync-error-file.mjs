#!/usr/bin/env node
// Copy the node-side of @actual-app/error-file into cli/ and mcp/ (pm/error_err.mdx §4.6).
//
// cli/ and mcp/ live outside the yarn workspace and compile with plain tsc (rootDir: src), so they
// cannot import workspace TypeScript. They get a vendored copy instead — and "copy" must never
// mean "drift": packages/error-file/src/vendor-drift.test.ts fails if a copy differs from the
// source after the header. The root justfile `build` runs this first.
//
//   node scripts/sync-error-file.mjs          write the copies
//   node scripts/sync-error-file.mjs --check  exit 1 if any copy is stale (writes nothing)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages/error-file/src');

export const VENDORED_FILES = [
  'index.ts',
  'core.ts',
  'describe.ts',
  'redact.ts',
  'fold.ts',
  'format.ts',
  'node.ts',
  'rolling-file-writer.ts',
  'ingest.ts',
];

export const VENDOR_DIRS = [
  'cli/code/src/vendor/error-file',
  'mcp/src/vendor/error-file',
  // desktop-electron runs tsgo-compiled CommonJS in build/, so it cannot import workspace TS either.
  'packages/desktop-electron/vendor/error-file',
];

export const HEADER =
  '// GENERATED from packages/error-file — run scripts/sync-error-file.mjs\n';

const check = process.argv.includes('--check');
let stale = 0;

for (const dir of VENDOR_DIRS) {
  const target = join(root, dir);
  if (!check) mkdirSync(target, { recursive: true });
  for (const file of VENDORED_FILES) {
    const wanted = HEADER + readFileSync(join(source, file), 'utf8');
    const dest = join(target, file);
    const current = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (current === wanted) continue;
    stale++;
    if (check) {
      console.error(`stale: ${relative(root, dest)}`);
    } else {
      writeFileSync(dest, wanted);
      console.log(`wrote ${relative(root, dest)}`);
    }
  }
}

if (check && stale > 0) {
  console.error(
    `${stale} vendored error-file copies are stale — run node scripts/sync-error-file.mjs`,
  );
  process.exit(1);
}
if (!check) {
  console.log(
    stale ? `synced ${stale} files` : 'vendored error-file copies are current',
  );
}
