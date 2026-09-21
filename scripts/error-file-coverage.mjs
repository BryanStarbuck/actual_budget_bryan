#!/usr/bin/env node
// Error-file coverage report — pm/error_err.mdx §12.2.
//
// Walks every source file in scope (§12.3), runs the `actual/catch-must-report` lint rule over
// them with `oxlint --format json`, counts the error sites in each file with a cheap textual
// parse, and puts each file in one of four classes:
//
//   compliant        ≥1 error site, every site passes the rule
//   net-covered      0 local error sites; the runtime's global net (§7) covers it
//   violating        ≥1 site fails the rule
//   unwired-runtime  the file's runtime has no net installed — a hard failure (§7, §12.2)
//
// It prints totals, writes ~/T/actual_budget/error_file_coverage.json (outside the repo), and
// exits non-zero when any file is violating or unwired. `just check-errors` runs it.
//
//   node scripts/error-file-coverage.mjs            report + exit code
//   node scripts/error-file-coverage.mjs --quiet    totals only

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = process.argv.includes('--quiet');
const RULE = 'actual(catch-must-report)';
const OUT_FILE = join(
  homedir(),
  'T',
  'actual_budget',
  'error_file_coverage.json',
);

// ---------------------------------------------------------------------------------------------
// Scope (§12.3)
// ---------------------------------------------------------------------------------------------

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.mts']);

/** Directory roots that are walked recursively. */
const RECURSIVE_ROOTS = [
  ...readdirSync(join(root, 'packages'))
    .map(p => `packages/${p}/src`)
    .filter(p => existsSync(join(root, p))),
  'packages/sync-server/bin',
  'packages/cli/src',
  'cli/code/src',
  'mcp/src',
];

/** Single-directory roots: only the files directly inside count (§12.3). */
const FLAT_ROOTS = ['packages/desktop-electron', 'packages/api'];

const EXTRA_FILES = ['packages/sync-server/app.ts'];

const EXCLUDED_ROOTS = [
  'packages/docs/',
  'packages/component-library/src/icons/',
  'packages/eslint-plugin-actual/',
  'packages/ci-actions/',
  'packages/vite-plugin-peggy/',
  'packages/error-file/src/',
  'packages/crdt/src/proto/', // protobuf output
];

const EXCLUDED_DIR_NAMES = new Set([
  '__tests__',
  '__mocks__',
  '__snapshots__',
  'e2e',
  'mocks',
  'node_modules',
  'dist',
  'lib-dist',
  'build',
]);

function isExcludedFile(rel) {
  if (EXCLUDED_ROOTS.some(prefix => rel.startsWith(prefix))) return true;
  if (rel.includes('/vendor/error-file/')) return true;
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  if (/\.(test|spec|stories)\.[^.]+$/.test(base)) return true;
  if (base.endsWith('.d.ts')) return true;
  if (/^.*\.(config|setup)\.[cm]?[jt]s$/.test(base)) return true;
  return false;
}

function hasSourceExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot !== -1 && EXTENSIONS.has(name.slice(dot));
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.has(entry.name)) walk(abs, out);
    } else if (entry.isFile() && hasSourceExtension(entry.name)) {
      out.push(abs);
    }
  }
}

function collectInScope() {
  const abs = [];
  for (const r of RECURSIVE_ROOTS) {
    const dir = join(root, r);
    if (existsSync(dir)) walk(dir, abs);
  }
  for (const r of FLAT_ROOTS) {
    const dir = join(root, r);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isFile() && hasSourceExtension(name)) abs.push(p);
    }
  }
  for (const f of EXTRA_FILES) {
    if (existsSync(join(root, f))) abs.push(join(root, f));
  }
  const rels = new Set(
    abs
      .map(p => relative(root, p).replace(/\\/g, '/'))
      .filter(rel => !isExcludedFile(rel)),
  );
  return [...rels].sort();
}

// ---------------------------------------------------------------------------------------------
// Runtimes and their nets (§7)
// ---------------------------------------------------------------------------------------------

/**
 * Each runtime names the file whose net installs the sink for it, and the call that proves it.
 * A runtime is wired when that file contains the install call.
 */
const RUNTIMES = {
  web: {
    net: 'packages/desktop-client/src/index.tsx',
    install: 'installBrowserErrorFile(',
    nets: ['N1', 'N3', 'N4', 'N5', 'N15', 'N20'],
  },
  worker: {
    // N2: browser-server.js is an unbundled classic script; the install lives in the loot-core
    // bundle it loads and is called from the worker right after importScripts().
    net: 'packages/loot-core/src/server/main.ts',
    install: 'installBrowserErrorFile(',
    nets: ['N2', 'N6', 'N7', 'N8'],
  },
  'sync-server': {
    net: 'packages/sync-server/src/app.ts',
    install: 'installNodeErrorFile(',
    nets: ['N9', 'N10', 'N11', 'N12'],
  },
  'electron-main': {
    net: 'packages/desktop-electron/index.ts',
    install: 'installNodeErrorFile(',
    nets: ['N13', 'N14', 'N15'],
  },
  api: {
    net: 'packages/api/index.ts',
    install: 'installNodeErrorFile(',
    nets: ['N16'],
  },
  'actual-cli': {
    net: 'packages/cli/src/index.ts',
    install: 'installNodeErrorFile(',
    nets: ['N17'],
  },
  abx: {
    net: 'cli/code/src/index.ts',
    install: 'installNodeErrorFile(',
    nets: ['N18'],
  },
  mcp: {
    net: 'mcp/src/index.ts',
    install: 'installNodeErrorFile(',
    nets: ['N19'],
  },
};

/** Which runtime a file runs in, by its location. Libraries take the runtime of their host. */
function runtimeOf(rel) {
  if (rel.startsWith('packages/desktop-client/src/')) return 'web';
  if (rel.startsWith('packages/component-library/')) return 'web';
  if (rel.startsWith('packages/plugins-service/')) return 'web';
  if (rel.startsWith('packages/mobile-client/')) return 'web';
  if (rel.startsWith('packages/loot-core/')) return 'worker';
  if (rel.startsWith('packages/crdt/')) return 'worker';
  if (rel.startsWith('packages/sync-server/')) return 'sync-server';
  if (rel.startsWith('packages/desktop-electron/')) return 'electron-main';
  if (rel.startsWith('packages/api/')) return 'api';
  if (rel.startsWith('packages/cli/')) return 'actual-cli';
  if (rel.startsWith('cli/code/')) return 'abx';
  if (rel.startsWith('mcp/')) return 'mcp';
  return 'web';
}

function wiredRuntimes() {
  const result = {};
  for (const [name, { net, install }] of Object.entries(RUNTIMES)) {
    const p = join(root, net);
    result[name] = existsSync(p) && readFileSync(p, 'utf8').includes(install);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Error sites — the cheap count
// ---------------------------------------------------------------------------------------------

const SITE_PATTERNS = [
  /(?<![.\w])catch\s*\(/g,
  /(?<![.\w])catch\s*\{/g,
  /\.catch\s*\(/g,
  /\bonError\s*=/g,
  /addEventListener\(\s*['"]error['"]/g,
];

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function countSites(rel) {
  const src = stripComments(readFileSync(join(root, rel), 'utf8'));
  let n = 0;
  for (const re of SITE_PATTERNS) {
    re.lastIndex = 0;
    n += (src.match(re) || []).length;
  }
  return n;
}

// ---------------------------------------------------------------------------------------------
// The lint rule, over the in-scope files
// ---------------------------------------------------------------------------------------------

function lintViolations(files) {
  const perFile = new Map();
  // Long argument lists are fine on macOS/Linux, but split to be safe on any platform.
  const CHUNK = 400;
  for (let i = 0; i < files.length; i += CHUNK) {
    const chunk = files.slice(i, i + CHUNK);
    let stdout;
    try {
      stdout = execFileSync(
        'npx',
        [
          'oxlint',
          '--format',
          'json',
          '-A',
          'all',
          '-W',
          'actual/catch-must-report',
          ...chunk,
        ],
        {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 256 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (e) {
      // oxlint exits non-zero when it reports errors; the JSON is still on stdout.
      stdout = e.stdout;
      if (typeof stdout !== 'string' || stdout.length === 0) {
        throw new Error(`oxlint failed: ${e.stderr || e.message}`);
      }
    }
    const parsed = JSON.parse(stdout);
    for (const d of parsed.diagnostics || []) {
      if (d.code !== RULE) continue;
      const rel = String(d.filename).replace(/\\/g, '/');
      const label = d.labels?.[0]?.span;
      const list = perFile.get(rel) || [];
      list.push({
        line: label?.line ?? 0,
        column: label?.column ?? 0,
        message: d.message,
      });
      perFile.set(rel, list);
    }
  }
  return perFile;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const files = collectInScope();
const wired = wiredRuntimes();
const violations = lintViolations(files);

const report = [];
for (const rel of files) {
  const runtime = runtimeOf(rel);
  const found = violations.get(rel) || [];
  const sites = Math.max(countSites(rel), found.length);
  let cls;
  if (!wired[runtime]) cls = 'unwired-runtime';
  else if (found.length > 0) cls = 'violating';
  else if (sites > 0) cls = 'compliant';
  else cls = 'net-covered';
  report.push({
    file: rel,
    runtime,
    sites,
    violations: found.length,
    class: cls,
    diagnostics: found,
  });
}

const totals = {
  compliant: 0,
  'net-covered': 0,
  violating: 0,
  'unwired-runtime': 0,
};
for (const r of report) totals[r.class]++;
const unwiredRuntimes = Object.entries(wired)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);
const violatingAnywhere = report.filter(r => r.violations > 0).length;
const sitesTotal = report.reduce((n, r) => n + r.sites, 0);
const violationsTotal = report.reduce((n, r) => n + r.violations, 0);

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      totals: {
        files: report.length,
        ...totals,
        errorSites: sitesTotal,
        violations: violationsTotal,
        filesWithViolations: violatingAnywhere,
      },
      runtimes: Object.fromEntries(
        Object.entries(RUNTIMES).map(([name, r]) => [
          name,
          { net: r.net, nets: r.nets, wired: wired[name] },
        ]),
      ),
      unwiredRuntimes,
      files: report,
    },
    null,
    2,
  ) + '\n',
);

if (!quiet) {
  const byRuntime = {};
  for (const r of report) {
    const b = (byRuntime[r.runtime] ||= {
      files: 0,
      sites: 0,
      violations: 0,
      violatingFiles: 0,
    });
    b.files++;
    b.sites += r.sites;
    b.violations += r.violations;
    if (r.violations > 0) b.violatingFiles++;
  }
  console.log(
    'runtime          wired  files  sites  violations  violating-files',
  );
  for (const [name, b] of Object.entries(byRuntime)) {
    console.log(
      `${name.padEnd(16)} ${String(wired[name] ? 'yes' : 'NO').padEnd(6)} ${String(b.files).padStart(5)}  ${String(b.sites).padStart(5)}  ${String(b.violations).padStart(10)}  ${String(b.violatingFiles).padStart(15)}`,
    );
  }
  console.log('');
}

console.log(
  `error-file coverage (pm/error_err.mdx §12.2) — ${report.length} files in scope`,
);
console.log(`  compliant        ${totals.compliant}`);
console.log(`  net-covered      ${totals['net-covered']}`);
console.log(`  violating        ${totals.violating}`);
console.log(
  `  unwired-runtime  ${totals['unwired-runtime']}${unwiredRuntimes.length ? `  (${unwiredRuntimes.join(', ')})` : ''}`,
);
console.log(
  `  error sites ${sitesTotal}, violations ${violationsTotal} in ${violatingAnywhere} files`,
);
console.log(`  report: ${OUT_FILE}`);

if (totals.violating > 0 || totals['unwired-runtime'] > 0) {
  process.exitCode = 1;
}
