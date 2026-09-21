// §4.6 / §14.1 — the cli/, mcp/ and desktop-electron copies match the source byte for byte after the header.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const HEADER =
  '// GENERATED from packages/error-file — run scripts/sync-error-file.mjs\n';
const FILES = [
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
const DIRS = [
  'cli/code/src/vendor/error-file',
  'mcp/src/vendor/error-file',
  'packages/desktop-electron/vendor/error-file',
];

describe('vendor drift', () => {
  it('the sync script vendors exactly the files this test checks', () => {
    const script = readFileSync(
      join(root, 'scripts/sync-error-file.mjs'),
      'utf8',
    );
    for (const file of FILES) expect(script).toContain(`'${file}'`);
    for (const dir of DIRS) expect(script).toContain(`'${dir}'`);
    expect(script).toContain(JSON.stringify(HEADER.trimEnd()).slice(1, -1));
  });

  for (const dir of DIRS) {
    for (const file of FILES) {
      it(`${dir}/${file} matches packages/error-file/src/${file}`, () => {
        const copy = join(root, dir, file);
        expect(
          existsSync(copy),
          `${copy} is missing — run node scripts/sync-error-file.mjs`,
        ).toBe(true);
        const text = readFileSync(copy, 'utf8');
        expect(text.startsWith(HEADER)).toBe(true);
        expect(
          text.slice(HEADER.length) ===
            readFileSync(join(root, 'packages/error-file/src', file), 'utf8'),
          `${dir}/${file} has drifted — run node scripts/sync-error-file.mjs`,
        ).toBe(true);
      });
    }
  }
});
