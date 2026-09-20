/**
 * Output contracts — pm/cli.mdx §13.
 *
 * Two rules, both load-bearing:
 *
 *   1. stdout carries EXACTLY ONE payload. The spinner, warnings, the resolved
 *      target and every diagnostic go to stderr. The test is concrete:
 *      `abx statements missing > gaps.txt` must produce a file with nothing in
 *      it but month lines, and `abx accounts list --format json | jq` must
 *      never choke on a banner.
 *
 *   2. Money is integer cents everywhere (§13.3). Cents become a decimal
 *      STRING in exactly one function, only for display, and never travel
 *      back. --format json always carries the raw integer.
 *
 * `out()` below is the ONLY sanctioned writer to stdout in this codebase. A
 * canary greps the BUILT dist/ for console.log and process.stdout.write
 * outside this module — grepping the output rather than the source, because
 * that catches a violation bundled in from a dependency.
 */
export type Format = 'json' | 'table' | 'csv';

export function parseFormat(raw: string | undefined): Format {
  if (raw === undefined) {
    return 'json';
  }
  if (raw === 'json' || raw === 'table' || raw === 'csv') {
    return raw;
  }
  throw new Error(`--format must be json, table or csv, got "${raw}".`);
}

/** The one sanctioned stdout writer. */
export function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Integer cents to a decimal string — the ONLY place this conversion happens.
 *
 * A second place that turns cents into dollars is a second place they can be
 * turned into dollars wrongly. Note the arithmetic is entirely integer: we
 * never divide by 100 in floating point, because that is the operation that
 * turns a ledger into one that is off by a cent.
 */
export function centsToDecimal(
  cents: number,
  { separators = false }: { separators?: boolean } = {},
): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`Amount ${cents} is not an integer number of cents.`);
  }

  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const whole = Math.trunc(absolute / 100);
  const fraction = absolute % 100;

  const wholeText = separators ? whole.toLocaleString('en-US') : String(whole);

  return `${negative ? '-' : ''}${wholeText}.${String(fraction).padStart(2, '0')}`;
}

/** RFC 4180: quote if the field holds a comma, quote or newline; double the quotes. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export type Column = {
  key: string;
  header: string;
  /** Cents columns render as decimals in table/csv and stay integers in json. */
  money?: boolean;
  align?: 'left' | 'right';
};

export type Row = Record<string, unknown>;

function cell(row: Row, column: Column, separators: boolean): string {
  const value = row[column.key];
  if (value === null || value === undefined) {
    // §10 of mcp.mdx, which governs here too: a category with no budget entry
    // is not a category budgeted zero, so a null never renders as 0.00.
    return '—';
  }
  if (column.money === true && typeof value === 'number') {
    return centsToDecimal(value, { separators });
  }
  return String(value);
}

function renderTable(rows: Row[], columns: Column[]): string {
  if (rows.length === 0) {
    return '';
  }

  const body = rows.map(row => columns.map(column => cell(row, column, true)));
  const widths = columns.map((column, index) =>
    Math.max(
      column.header.length,
      ...body.map(line => (line[index] ?? '').length),
    ),
  );

  const pad = (text: string, index: number): string => {
    const width = widths[index] ?? text.length;
    const column = columns[index];
    const right = column?.align === 'right' || column?.money === true;
    return right ? text.padStart(width) : text.padEnd(width);
  };

  const header = columns.map((column, i) => pad(column.header, i)).join('  ');
  const rule = widths.map(width => '─'.repeat(width)).join('  ');
  const lines = body.map(line => line.map(pad).join('  ').trimEnd());

  return [header.trimEnd(), rule, ...lines].join('\n');
}

function renderCsv(rows: Row[], columns: Column[]): string {
  const header = columns.map(column => csvField(column.header)).join(',');
  const lines = rows.map(row =>
    columns
      .map(column => {
        const value = row[column.key];
        if (column.money === true && typeof value === 'number') {
          // No separators and no currency symbol: a CSV amount is for a
          // spreadsheet, and "1,234.50" is two cells in one.
          return csvField(centsToDecimal(value));
        }
        return csvField(value);
      })
      .join(','),
  );
  return [header, ...lines].join('\n');
}

/**
 * Render one payload in the requested format.
 *
 * `envelope` is the machine plane's reply, verbatim — json mode prints it
 * whole, including meta, because a balance without its `asOf` is a number
 * that will be wrong tomorrow.
 */
export function render(
  format: Format,
  envelope: unknown,
  rows: Row[],
  columns: Column[],
): string {
  switch (format) {
    case 'json':
      return JSON.stringify(envelope, null, 2);
    case 'table':
      return renderTable(rows, columns);
    case 'csv':
      return renderCsv(rows, columns);

    default:
      // parseFormat() is the only way to build a Format, so this is a new
      // format added without a renderer rather than bad user input.
      throw new Error(`No renderer for format "${String(format)}".`);
  }
}
