/**
 * The canaries — pm/mcp.mdx §7.0, §17.
 *
 * Each asserts a property that no amount of care keeps true on its own,
 * because the way it breaks is invisible at the diff.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const repoRoot = path.resolve(mcpRoot, '..');
const srcDir = path.join(mcpRoot, 'src');
const distDir = path.join(mcpRoot, 'dist');

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

const built = () => walk(distDir, '.js');

describe('stdout purity (§8.1) — the canary that matters most', () => {
  /**
   * One console.log anywhere in this process corrupts the JSON-RPC stream,
   * and the symptom is not an error: the client goes quiet, because it is
   * waiting for a message that arrived interleaved with a log line it could
   * not parse.
   *
   * Greps the BUILT output rather than the source, because that is what
   * catches a violation bundled in from a dependency.
   */
  it('nothing in the built bundle writes to stdout', () => {
    const files = built();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [
        'console.log(',
        'console.info(',
        'process.stdout.write(',
      ]) {
        if (source.includes(pattern)) {
          offenders.push(`${path.relative(mcpRoot, file)}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('there is no out() function — the one CLI shape not to port', () => {
    for (const file of walk(srcDir, '.ts')) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/export function out\b/);
    }
  });
});

describe('no-network canary (§7.0 T9)', () => {
  it('the built bundle names no host but loopback', () => {
    const offenders: string[] = [];
    for (const file of built()) {
      const source = fs.readFileSync(file, 'utf8');
      // Any http(s) URL literal that is not loopback.
      for (const match of source.matchAll(/https?:\/\/[^'"`\s)]+/g)) {
        const url = match[0];
        if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(url)) {
          offenders.push(`${path.relative(mcpRoot, file)}: ${url}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exactly one of OUR modules opens a socket', () => {
    // A bare global `fetch(` — not `.fetch(`, not `#fetch(`, which are method
    // names and open nothing. The point is which module can reach the
    // network, not which module happens to use the word.
    const fetchers = walk(srcDir, '.ts').filter(file =>
      /(?<![.#\w])fetch\s*\(/.test(fs.readFileSync(file, 'utf8')),
    );
    expect(fetchers.map(f => path.basename(f))).toEqual(['client.ts']);
  });
});

describe('no-shell canary (§7.0 T9)', () => {
  it('our source imports no child_process and evaluates nothing', () => {
    // Shelling out would mean the agent has shell. This server has no reason
    // to spawn anything, and the absence is the control.
    for (const file of walk(srcDir, '.ts')) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+'node:child_process'/);
      expect(source, file).not.toMatch(/\beval\s*\(/);
      expect(source, file).not.toMatch(/new\s+Function\s*\(/);
    }
  });
});

describe('no-fs-write canary (§7.0 T6)', () => {
  it('only the logger and the credential minter touch the filesystem for writing', () => {
    const allowed = new Set(['logger.ts', 'credentials.ts']);
    const offenders: string[] = [];

    for (const file of walk(srcDir, '.ts')) {
      if (allowed.has(path.basename(file))) {
        continue;
      }
      const source = fs.readFileSync(file, 'utf8');
      for (const pattern of [
        'writeFileSync',
        'appendFileSync',
        'mkdirSync',
        'rmSync',
        'unlinkSync',
        'renameSync',
      ]) {
        if (source.includes(pattern)) {
          offenders.push(`${path.relative(mcpRoot, file)}: ${pattern}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('audit canary (§7.0 T11, §16.2)', () => {
  it('the allowlist contains no field that could carry money or identity', () => {
    // Asserted against the list itself, so adding `account_id` or `payee` to
    // it fails here rather than quietly writing somebody's payee to a log.
    const forbidden = [
      'account_id',
      'category_id',
      'transaction_id',
      'payee',
      'payee_name',
      'amount',
      'notes',
      'path',
      'map_path',
      'confirm',
    ];
    const source = fs.readFileSync(path.join(srcDir, 'audit.ts'), 'utf8');
    const block = source.split('LOGGABLE_SCALARS')[1]?.split(']')[0] ?? '';
    for (const field of forbidden) {
      expect(block, `LOGGABLE_SCALARS must not contain ${field}`).not.toContain(
        `'${field}'`,
      );
    }
  });
});

describe('instructions freshness (§3.4)', () => {
  const promptFile = path.join(repoRoot, 'ai', 'mcp_prompt.md');
  const generated = path.join(srcDir, 'instructions.ts');

  it('the prompt file exists and is not empty', () => {
    expect(fs.existsSync(promptFile)).toBe(true);
    expect(fs.readFileSync(promptFile, 'utf8').trim().length).toBeGreaterThan(
      500,
    );
  });

  it('the checked-in artifact matches what the prompt generates', () => {
    const before = fs.readFileSync(generated, 'utf8');
    execFileSync(
      process.execPath,
      [path.join(mcpRoot, 'scripts', 'build-instructions.mjs')],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    const after = fs.readFileSync(generated, 'utf8');
    expect(after).toBe(before);
  });

  it('ships no unsubstituted {TOKEN}', async () => {
    // A literal brace reaching the model is worse than not building: it reads
    // "{TOOL_PREFIX}list_accounts" and there is no such tool.
    const { INSTRUCTIONS } = (await import('../src/instructions.js')) as {
      INSTRUCTIONS: string;
    };
    expect(INSTRUCTIONS).not.toMatch(/\{[A-Z0-9_]+\}/);
  });

  it('opens with the routing test, verbatim (§3.4 layer 5)', async () => {
    const { INSTRUCTIONS } = (await import('../src/instructions.js')) as {
      INSTRUCTIONS: string;
    };
    expect(INSTRUCTIONS.trimStart()).toMatch(
      /^Is this about the operator's own personal or household budget/,
    );
    // Both neighbours named, so a model that has read only this far already
    // knows where the other two kinds of question go.
    const firstParagraph = INSTRUCTIONS.split('\n\n')[0] ?? '';
    expect(firstParagraph).toContain('quickbooks');
    expect(firstParagraph).toContain('act3');
  });

  it('states the catalogue size the registry actually has', async () => {
    const { INSTRUCTIONS } = (await import('../src/instructions.js')) as {
      INSTRUCTIONS: string;
    };
    const { TOOL_COUNTS } = await import('../src/tools/registry.js');
    expect(INSTRUCTIONS).toContain(
      `There are ${TOOL_COUNTS.total} of them: ${TOOL_COUNTS.read} read and ${TOOL_COUNTS.write} write`,
    );
  });
});

describe('open-source safety (cli.mdx §17)', () => {
  it('no private path and no secret-shaped literal in the source', () => {
    for (const file of walk(srcDir, '.ts')) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\/Users\//);
      expect(source, file).not.toMatch(/Bryan_Arindom/);
      expect(source, file).not.toMatch(/['"`][0-9a-f]{32,}['"`]/);
    }
  });

  it("never reads a human credential or another product's state", () => {
    for (const file of walk(srcDir, '.ts')) {
      const source = fs.readFileSync(file, 'utf8');
      for (const forbidden of [
        'ACTUAL_PASSWORD',
        'ACTUAL_SESSION_TOKEN',
        '.actual-cli',
        '.act3',
        'quickbooks_token',
      ]) {
        expect(source, `${file} mentions ${forbidden}`).not.toContain(
          forbidden,
        );
      }
    }
  });

  it('is marked private so it can never be published', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(mcpRoot, 'package.json'), 'utf8'),
    ) as { private?: boolean };
    expect(pkg.private).toBe(true);
  });
});

describe('credentials parity (§4)', () => {
  /** Below the import block the two copies must be byte-identical. */
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

  it('matches the sync-server original', () => {
    const original = path.join(
      repoRoot,
      'packages',
      'sync-server',
      'src',
      'machine',
      'credentials-file.ts',
    );
    expect(fs.existsSync(original)).toBe(true);
    expect(bodyOf(path.join(srcDir, 'credentials.ts'))).toBe(bodyOf(original));
  });
});
