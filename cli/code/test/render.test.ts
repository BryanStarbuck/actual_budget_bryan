import { describe, expect, it } from 'vitest';

import { centsToDecimal, parseFormat, render } from '../src/render.js';
import type { Column } from '../src/render.js';

const COLUMNS: Column[] = [
  { key: 'name', header: 'name' },
  { key: 'balance', header: 'balance', money: true },
];

describe('centsToDecimal — the only cents-to-dollars conversion (§13.3)', () => {
  it('renders the obvious cases', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(50)).toBe('0.50');
    expect(centsToDecimal(-12350)).toBe('-123.50');
    expect(centsToDecimal(100000)).toBe('1000.00');
  });

  it('adds separators only when asked — a CSV amount must be one cell', () => {
    expect(centsToDecimal(123456789, { separators: true })).toBe(
      '1,234,567.89',
    );
    expect(centsToDecimal(123456789)).toBe('1234567.89');
  });

  /**
   * The failure this rule exists to prevent is not dramatic, which is why it
   * survives: a float turns a budget into one that is off by a cent, nobody
   * notices for three months, and then somebody spends a day proving the app
   * is broken when it is not.
   */
  it('stays exact where a float divide would not', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; integer cents never care.
    expect(centsToDecimal(10 + 20)).toBe('0.30');
    // A large value that a /100 float divide would render as 92233720368.55
    expect(centsToDecimal(999999999999)).toBe('9999999999.99');
  });

  it('refuses a non-integer rather than rounding it into existence', () => {
    expect(() => centsToDecimal(12.5)).toThrow(/not an integer/);
  });
});

describe('render', () => {
  const rows = [
    { name: 'Chase Checking', balance: -12350 },
    { name: 'Savings', balance: 4200000 },
  ];

  it('json carries the RAW INTEGER, never a decimal', () => {
    const envelope = { ok: true, data: rows };
    const text = render('json', envelope, rows, COLUMNS);
    expect(text).toContain('-12350');
    expect(text).not.toContain('-123.50');
  });

  it('table renders decimals with separators, right-aligned', () => {
    const text = render('table', {}, rows, COLUMNS);
    expect(text).toContain('-123.50');
    expect(text).toContain('42,000.00');
  });

  it('csv renders decimals with no separators and no currency symbol', () => {
    const text = render('csv', {}, rows, COLUMNS);
    const lines = text.split('\n');
    expect(lines[0]).toBe('name,balance');
    expect(lines[1]).toBe('Chase Checking,-123.50');
    expect(lines[2]).toBe('Savings,42000.00');
  });

  it('quotes a CSV field holding a comma, per RFC 4180', () => {
    const text = render(
      'csv',
      {},
      [{ name: 'Smith, John', balance: 0 }],
      COLUMNS,
    );
    expect(text).toContain('"Smith, John"');
  });

  it('doubles an embedded quote rather than escaping it', () => {
    const text = render(
      'csv',
      {},
      [{ name: 'The "Shop"', balance: 0 }],
      COLUMNS,
    );
    expect(text).toContain('"The ""Shop"""');
  });

  /**
   * mcp.mdx §10.2, which governs here too: a category with no budget entry is
   * NOT a category budgeted zero. A model — or a human — reading `0.00` will
   * answer "yes, zero", which is a confident wrong answer about the
   * operator's own intent.
   */
  it('renders an absent value as — and never as 0.00', () => {
    const text = render(
      'table',
      {},
      [{ name: 'Groceries', balance: null }],
      COLUMNS,
    );
    expect(text).toContain('—');
    expect(text).not.toContain('0.00');
  });
});

describe('parseFormat', () => {
  it('defaults to json', () => {
    expect(parseFormat(undefined)).toBe('json');
  });

  it('rejects anything else', () => {
    expect(() => parseFormat('yaml')).toThrow(/json, table or csv/);
  });
});
