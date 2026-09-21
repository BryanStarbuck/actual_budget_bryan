import { describeError, stripControlChars, trimStack } from './describe.ts';
import { formatRecord } from './format.ts';
import type { ErrorRecord } from './format.ts';

function record(overrides: Partial<ErrorRecord> = {}): ErrorRecord {
  return {
    ts: '2026-09-21T16:04:11.902Z',
    level: 'ERROR',
    app: 'sync-server',
    where: 'sync-server/src/machine/index.ts',
    doing: 'handling POST /machine/v1/transactions/import',
    error: "TypeError: Cannot read properties of undefined (reading 'id')",
    cause: ' | cause: SqliteError: SQLITE_BUSY (code=SQLITE_BUSY)',
    stack:
      '    at importTransactions (packages/loot-core/src/server/accounts/sync.ts:812:19)',
    data: { route: 'transactions.import' },
    ...overrides,
  };
}

describe('format', () => {
  it('renders the §3.2 line shape', () => {
    expect(formatRecord(record())).toBe(
      "[2026-09-21T16:04:11.902Z] [ERROR] [sync-server] [sync-server/src/machine/index.ts] handling POST /machine/v1/transactions/import — TypeError: Cannot read properties of undefined (reading 'id') {route=transactions.import} | cause: SqliteError: SQLITE_BUSY (code=SQLITE_BUSY)\n" +
        '    at importTransactions (packages/loot-core/src/server/accounts/sync.ts:812:19)\n',
    );
  });

  it('walks the cause chain, cause before stack, codes appended', () => {
    const root = Object.assign(new Error('SQLITE_BUSY'), {
      code: 'SQLITE_BUSY',
    });
    root.name = 'SqliteError';
    const err = new TypeError('outer', { cause: root });
    expect(describeError(err)).toBe(
      'TypeError: outer | cause: SqliteError: SQLITE_BUSY (code=SQLITE_BUSY)',
    );
  });

  it('stops a circular cause chain', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(describeError(a)).toBe('Error: a | cause: Error: b');
  });

  it('trims the stack: drops node_modules and library frames, shortens paths, caps at 12', () => {
    const frames = [
      'Error: boom',
      '    at ours (/Users/someone/repo/packages/loot-core/src/a.ts:1:2)',
      '    at dep (/Users/someone/repo/node_modules/express/lib/router.js:3:4)',
      '    at lib (/Users/someone/repo/packages/error-file/src/core.ts:5:6)',
      ...Array.from(
        { length: 20 },
        (_, i) => `    at f${i} (/x/packages/api/b.ts:${i}:1)`,
      ),
    ].join('\n');
    const out = trimStack(frames).split('\n');
    expect(out[0]).toBe('    at ours (packages/loot-core/src/a.ts:1:2)');
    expect(out.some(l => l.includes('node_modules'))).toBe(false);
    expect(out.some(l => l.includes('error-file'))).toBe(false);
    expect(out).toHaveLength(12);
  });

  it('a message cannot forge a second header line', () => {
    const text = formatRecord(
      record({
        error: 'Error: bad\n[2026-01-01T00:00:00.000Z] [ERROR] [web] forged',
        cause: '',
        stack: '',
        data: null,
      }),
    );
    expect(text.split('\n')).toHaveLength(2); // one line + the terminating newline
    expect(stripControlChars('a\u2028b\u2029c\x7fd')).toBe('a b c d');
  });

  it('caps the message in the middle, the data block, and the whole record', () => {
    const long = 'x'.repeat(5000) + 'END';
    const err = new Error(long);
    const described = describeError(err);
    expect(described.length).toBeLessThanOrEqual(2000);
    expect(described.endsWith('END')).toBe(true);
    const data: Record<string, string> = {};
    for (let i = 0; i < 40; i++) data[`k${i}`] = 'v'.repeat(100);
    const line = formatRecord(record({ data, stack: '', cause: '' }));
    const block = line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1);
    expect(block.length).toBeLessThanOrEqual(1002);
    const huge = formatRecord(record({ stack: `    at x\n`.repeat(3000) }));
    expect(huge.length).toBeLessThanOrEqual(8001);
  });

  it('describes primitives and throwing values without throwing', () => {
    expect(describeError('plain string')).toBe('Thrown string: plain string');
    expect(describeError(42)).toBe('Thrown number: 42');
    const hostile = {
      get message(): string {
        throw new Error('getter');
      },
      toString(): string {
        throw new Error('toString');
      },
    };
    expect(() => describeError(hostile)).not.toThrow();
  });
});
