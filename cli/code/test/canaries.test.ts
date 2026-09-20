/**
 * The canaries — pm/cli.mdx §17, §18.
 *
 * Each of these asserts a property that no amount of care keeps true on its
 * own, because the way it breaks is invisible at the diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(cliRoot, '..');
const srcDir = path.join(cliRoot, 'code', 'src');
const distDir = path.join(cliRoot, 'code', 'dist');

function walk(dir: string, ext: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(full, ext);
    }
    return entry.name.endsWith(ext) ? [full] : [];
  });
}

/** Everything below the import block — the part that must not drift. */
function bodyOf(file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let lastImport = -1;
  for (const [index, line] of lines.entries()) {
    if (/^import\s/.test(line) || /^}\s+from\s/.test(line)) {
      lastImport = index;
    }
  }
  return lines
    .slice(lastImport + 1)
    .join('\n')
    .trim();
}

describe('credentials parity (mcp.mdx §4)', () => {
  /**
   * The credentials reader is shared by COPY, not by import, because a
   * cross-directory import between two independently built top-level tools is
   * a build-order dependency nobody wants. The cost of that choice is drift,
   * and drift here does not announce itself: the two copies disagree about a
   * key, and the symptom is a 401 six weeks later that looks like a server
   * problem. So the copies are checked.
   */
  it('the CLI copy matches the server original below the imports', () => {
    const server = path.join(
      repoRoot,
      'packages',
      'sync-server',
      'src',
      'machine',
      'credentials-file.ts',
    );
    const cli = path.join(srcDir, 'credentials.ts');

    expect(fs.existsSync(server)).toBe(true);
    expect(bodyOf(cli)).toBe(bodyOf(server));
  });
});

describe('stdout purity (§13.1)', () => {
  /**
   * Greps the BUILT output, not the source, because that is what catches a
   * violation bundled in from a dependency — which grepping source cannot.
   *
   * stdout carries exactly one payload. The concrete test is that
   * `abx statements missing > gaps.txt` produces a file holding nothing but
   * month lines; a stray console.log anywhere breaks that for every verb at
   * once.
   */
  it('nothing writes to stdout outside the sanctioned renderer', () => {
    const built = walk(distDir, '.js');
    expect(built.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of built) {
      // render.js owns out(); main.js writes help and usage deliberately.
      if (/(^|[/\\])(render|main)\.js$/.test(file)) {
        continue;
      }
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [
        'console.log(',
        'console.info(',
        'process.stdout.write(',
      ]) {
        if (source.includes(pattern)) {
          offenders.push(`${path.relative(cliRoot, file)}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('open-source safety (§17)', () => {
  const sources = walk(srcDir, '.ts');

  it('no private path is hard-coded anywhere in the source', () => {
    // The statements root, the budget id, the entity names — all
    // configuration, none constants. The example paths in the spec are
    // illustrations of a configured value, not defaults in code.
    const forbidden = [/\/Users\//, /Bryan_Arindom/, /bank_statements/];
    const offenders: string[] = [];

    for (const file of sources) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          offenders.push(`${path.relative(cliRoot, file)}: ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no secret-shaped literal is committed', () => {
    // A 32+ character hex literal in the tree is a key somebody pasted.
    const offenders: string[] = [];
    for (const file of sources) {
      const source = fs.readFileSync(file, 'utf8');
      for (const match of source.matchAll(/['"`][0-9a-f]{32,}['"`]/g)) {
        offenders.push(
          `${path.relative(cliRoot, file)}: ${match[0].slice(0, 12)}…`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the package is marked private so it can never be published', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8'),
    ) as { private?: boolean; name?: string };

    expect(pkg.private).toBe(true);
    // And it is NOT the upstream CLI (§1).
    expect(pkg.name).not.toBe('@actual-app/cli');
  });
});

describe('we are not the upstream CLI (§1.3)', () => {
  const sources = walk(srcDir, '.ts');

  it('never reads a human credential', () => {
    // Reading a password is the upstream CLI's job and its risk profile. A
    // second reader of a secret is a second place it can leak, and this repo
    // is going public.
    const forbidden = [
      'ACTUAL_PASSWORD',
      'ACTUAL_SESSION_TOKEN',
      'ACTUAL_ENCRYPTION_PASSWORD',
    ];
    const offenders: string[] = [];

    for (const file of sources) {
      const source = fs.readFileSync(file, 'utf8');
      for (const name of forbidden) {
        if (source.includes(name)) {
          offenders.push(`${path.relative(cliRoot, file)}: ${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never touches the upstream CLI's budget cache", () => {
    // A second writer to ~/.actual-cli/data corrupts it, and the symptom
    // appears days later as phantom transactions.
    for (const file of sources) {
      expect(fs.readFileSync(file, 'utf8')).not.toContain('.actual-cli');
    }
  });
});
