import { describe, expect, it } from 'vitest';

import {
  getBoolean,
  getNumber,
  getString,
  parseArgs,
  UNIVERSAL_FLAGS,
} from '../src/args.js';
import type { FlagSpecs } from '../src/args.js';
import { Exit } from '../src/exit.js';

const SPECS: FlagSpecs = {
  ...UNIVERSAL_FLAGS,
  account: { arity: 'string', help: 'the account id' },
  start: { arity: 'date', help: 'inclusive start date' },
  amount: { arity: 'cents', help: 'integer cents' },
  prefer: { arity: 'path', help: 'resolve a conflict in favour of this file' },
  force: { arity: 'boolean', help: 're-extract' },
};

function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: number }).code;
  }
}

describe('parseArgs', () => {
  it('separates positionals from flags wherever they appear', () => {
    const args = parseArgs(
      ['scan', '--force', '/tmp/x', '--account', 'a1'],
      SPECS,
    );
    expect(args.positionals).toEqual(['scan', '/tmp/x']);
    expect(getBoolean(args, 'force')).toBe(true);
    expect(getString(args, 'account')).toBe('a1');
  });

  it('accepts --flag=value as well as --flag value', () => {
    const args = parseArgs(['--account=a1', '--start=2026-01-01'], SPECS);
    expect(getString(args, 'account')).toBe('a1');
    expect(getString(args, 'start')).toBe('2026-01-01');
  });

  it('treats everything after -- as a positional', () => {
    const args = parseArgs(['--', '--not-a-flag'], SPECS);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });

  /**
   * The §7.3 regression. A value-taking flag that the parser does not know
   * about parses as a boolean, so the value becomes a stray positional and
   * the verb silently does the wrong thing. The spec's own draft list was
   * missing --prefer, --path and --lines, which is why the list is gone and
   * arity is declared on the verb.
   */
  describe('the missed-arity bug the derived design prevents', () => {
    it('consumes the value of every DECLARED value flag', () => {
      const args = parseArgs(['--prefer', '/statements/jan.pdf'], SPECS);
      // The path is the flag's value, NOT a stray positional.
      expect(getString(args, 'prefer')).toBe('/statements/jan.pdf');
      expect(args.positionals).toEqual([]);
    });

    it('refuses a value flag with nothing after it rather than silently coercing', () => {
      expect(exitCodeOf(() => parseArgs(['--account'], SPECS))).toBe(
        Exit.usage,
      );
    });

    it('refuses a value passed to a boolean flag', () => {
      expect(exitCodeOf(() => parseArgs(['--force=yes'], SPECS))).toBe(
        Exit.usage,
      );
    });
  });

  it('rejects an unknown flag and suggests the nearest match', () => {
    try {
      parseArgs(['--acount', 'a1'], SPECS);
      expect.unreachable('should have rejected --acount');
    } catch (err) {
      expect((err as { code?: number }).code).toBe(Exit.usage);
      expect((err as { hint?: string }).hint).toContain('--account');
    }
  });

  describe('money is integer cents, always (§13.3)', () => {
    it('accepts an integer', () => {
      const args = parseArgs(['--amount', '-12350'], SPECS);
      expect(getNumber(args, 'amount')).toBe(-12350);
    });

    it('rejects a decimal and shows the integer the operator probably meant', () => {
      try {
        parseArgs(['--amount', '123.50'], SPECS);
        expect.unreachable('should have rejected a decimal amount');
      } catch (err) {
        expect((err as Error).message).toContain('--amount 12350');
      }
    });
  });

  it('rejects a malformed date rather than sending it to the server', () => {
    expect(exitCodeOf(() => parseArgs(['--start', '01/02/2026'], SPECS))).toBe(
      Exit.usage,
    );
  });
});
