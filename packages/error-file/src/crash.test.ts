// §14.2 — a fault survives the crash that caused it (R9, M11).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const src = pathToFileURL(__dirname).href;

// The child runs the TypeScript source directly: Node strips the types.
function childScript(body: string): string {
  return `
const { installNodeErrorFile } = await import('${src}/node.ts');
const { errorFileFor } = await import('${src}/core.ts');
installNodeErrorFile({ app: 'crash-test', file: process.env.CRASH_FILE, echo: false });
const errors = errorFileFor('error-file/src/crash.test.ts');
errors.caught('reporting the first fault', new Error('one'));
errors.caught('reporting the second fault', new Error('two'));
errors.warn('reporting the third fault', new Error('three'));
${body}
`;
}

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'error-file-crash-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(body: string): { status: number | null; text: string } {
  const script = join(dir, 'child.mjs');
  const file = join(dir, 'error.err');
  writeFileSync(script, childScript(body));
  const result = spawnSync(process.execPath, [script], {
    env: {
      ...process.env,
      CRASH_FILE: file,
      NODE_ENV: 'production',
      VITEST: '',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = `(no file) stderr: ${result.stderr}`;
  }
  return { status: result.status, text };
}

describe('crash test', () => {
  it('a synchronous throw: 3 records + FATAL on disk, and the process still dies', () => {
    const { status, text } = run(`throw new Error('synchronous crash');`);
    expect(status).not.toBe(0);
    expect(text).toContain('reporting the first fault — Error: one');
    expect(text).toContain('reporting the second fault — Error: two');
    expect(text).toContain(
      '[WARN] [crash-test] [error-file/src/crash.test.ts] reporting the third fault',
    );
    expect(text).toMatch(
      /\[FATAL\] \[crash-test\] .* an uncaught exception — Error: synchronous crash/,
    );
  });

  it('an unhandled rejection: 3 records + FATAL on disk, and Node still crashes', () => {
    const { status, text } = run(
      `Promise.reject(new Error('rejected crash'));`,
    );
    expect(status).not.toBe(0);
    expect(text).toContain('reporting the first fault — Error: one');
    expect(text).toMatch(
      /\[FATAL\] \[crash-test\] .* an unhandled promise rejection — Error: rejected crash/,
    );
    expect(text.match(/rejected crash/g)).toHaveLength(1);
  });
});
