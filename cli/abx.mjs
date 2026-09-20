#!/usr/bin/env node
/**
 * The self-building entry — pm/cli.mdx §2.3.
 *
 * `just build` builds the CLI, so this is a backstop rather than the normal
 * path. It exists so a freshly cloned repo works with zero setup steps even
 * if nobody ran `just`: compare source mtimes against dist/, compile when
 * stale, then run.
 *
 * Exit 69 (EX_UNAVAILABLE) if the build itself fails — a distinct code so a
 * script can tell "the tool is not built" from "the tool ran and failed".
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, 'code', 'src');
const distDir = path.join(here, 'code', 'dist');
const entry = path.join(distDir, 'index.js');

function newestMtime(dir) {
  let newest = 0;
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    const mtime = name.isDirectory()
      ? newestMtime(full)
      : fs.statSync(full).mtimeMs;
    if (mtime > newest) {
      newest = mtime;
    }
  }
  return newest;
}

function needsBuild() {
  if (!fs.existsSync(entry)) {
    return true;
  }
  try {
    return newestMtime(srcDir) > newestMtime(distDir);
  } catch {
    return true;
  }
}

if (needsBuild()) {
  // stdio inherit on stderr only — a build log must never land on stdout,
  // which belongs to the answer (§13.1).
  const result = spawnSync(
    process.execPath,
    [
      path.join(here, '..', 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      path.join(here, 'code', 'tsconfig.json'),
    ],
    { stdio: ['ignore', 'inherit', 'inherit'], cwd: here },
  );

  if (result.status !== 0) {
    process.stderr.write('abx: could not build the CLI (see errors above)\n');
    process.exit(69);
  }
}

await import(entry);
