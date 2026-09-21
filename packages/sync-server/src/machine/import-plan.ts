/**
 * The import plan — pm/apis.mdx §7.2, §11.6, §11.7; pm/import_formats.mdx §7, §8.
 *
 * ONE function runs the importer in preview mode and one runs it for real,
 * and they are the same call with one boolean different. There is no
 * `predictChanges()`: the plan IS `importTransactions(..., dryRun: true)`,
 * which runs the entire real reconciliation — imported_id lookup, the rules
 * engine, fuzzy matching, split handling — and returns what it would do with
 * nothing written. We never decide what is a duplicate (R7).
 *
 * The pinned options (§11.7) live here so both doors — JSON rows and a file
 * on disk — agree:
 *
 *   reimportDeleted  false   an import that resurrects rows the operator
 *                            deleted is an import nobody runs twice
 *   defaultCleared   true    a row that appeared on a statement has cleared
 *   strictIdChecking (engine default, true — import_formats.mdx §13.5)
 */
import type { EngineLib } from './engine.js';
import { MachineError } from './envelope.js';

export type ImportRow = {
  date: string;
  amount: number;
  payee_name?: string;
  imported_payee?: string;
  imported_id?: string;
  notes?: string;
  cleared?: boolean;
  category?: string;
};

export type ImportOptions = {
  reimport_deleted: boolean;
  payee_name_normalization: 'original' | 'title-case';
};

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  reimport_deleted: false,
  payee_name_normalization: 'title-case',
};

export type ImportChanges = {
  /** New rows the importer would insert. */
  added: number;
  /** Existing rows the importer would change (an exact or fuzzy match with a differing field). */
  updated: number;
  /** Existing rows matched with nothing to change — including reconciled (locked) ones. */
  unchanged: number;
  errors: string[];
};

export type Preview = {
  changes: ImportChanges;
  /** What the confirm token fingerprints: the input and the outcome, never engine-minted ids. */
  changeSet: unknown;
};

type ImporterResult = {
  errors: Array<{ message: string }>;
  added: string[];
  updated: string[];
  updatedPreview: Array<{
    transaction: { imported_id?: string | null };
    existing?: unknown;
    ignored?: boolean;
  }>;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Gate 5 for the rows themselves. Every failure names the row index and the
 * field, because "amount must be an integer" over 2,000 rows is not a hint.
 */
export function validateRows(raw: unknown): ImportRow[] {
  if (!Array.isArray(raw)) {
    throw new MachineError('invalid_input', 'transactions must be an array.');
  }
  return raw.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new MachineError(
        'invalid_input',
        `transactions[${i}] must be an object.`,
      );
    }
    const t = item as Record<string, unknown>;
    const allowed = new Set([
      'date',
      'amount',
      'payee_name',
      'imported_payee',
      'imported_id',
      'notes',
      'cleared',
      'category',
    ]);
    const unknown = Object.keys(t).filter(k => !allowed.has(k));
    if (unknown.length > 0) {
      throw new MachineError(
        'invalid_input',
        `transactions[${i}] has unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
        `a row accepts: ${[...allowed].join(', ')}`,
      );
    }
    if (typeof t.date !== 'string' || !DATE.test(t.date)) {
      throw new MachineError(
        'invalid_input',
        `transactions[${i}].date must be YYYY-MM-DD.`,
      );
    }
    if (typeof t.amount !== 'number' || !Number.isInteger(t.amount)) {
      throw new MachineError(
        'invalid_input',
        `transactions[${i}].amount must be an integer number of cents (got ${String(t.amount)}).`,
        'money is integer cents: -4520 is -$45.20',
      );
    }
    for (const field of ['payee_name', 'imported_payee', 'imported_id', 'notes', 'category']) {
      if (t[field] !== undefined && t[field] !== null && typeof t[field] !== 'string') {
        throw new MachineError('invalid_input', `transactions[${i}].${field} must be a string.`);
      }
    }
    if (t.cleared !== undefined && typeof t.cleared !== 'boolean') {
      throw new MachineError('invalid_input', `transactions[${i}].cleared must be true or false.`);
    }
    const row: ImportRow = { date: t.date, amount: t.amount };
    for (const field of ['payee_name', 'imported_payee', 'imported_id', 'notes', 'category'] as const) {
      const v = t[field];
      if (typeof v === 'string' && v !== '') {
        row[field] = v;
      }
    }
    if (typeof t.cleared === 'boolean') {
      row.cleared = t.cleared;
    }
    return row;
  });
}

async function runImporter(
  lib: EngineLib,
  accountId: string,
  rows: ImportRow[],
  options: ImportOptions,
  isPreview: boolean,
): Promise<ImporterResult> {
  const result = (await lib.send('api/transactions-import', {
    accountId,
    transactions: rows,
    isPreview,
    opts: {
      dryRun: isPreview,
      defaultCleared: true,
      reimportDeleted: options.reimport_deleted,
      payeeNameNormalization: options.payee_name_normalization,
    },
  })) as ImporterResult;
  return result;
}

function summarise(result: ImporterResult): ImportChanges {
  const unchanged = result.updatedPreview.filter(p => p.ignored).length;
  return {
    added: result.added.length,
    updated: result.updated.length,
    unchanged,
    errors: result.errors.map(e => e.message),
  };
}

/** The dry run. Nothing is written. */
export async function previewImport(
  lib: EngineLib,
  accountId: string,
  rows: ImportRow[],
  options: ImportOptions,
): Promise<Preview> {
  const result = await runImporter(lib, accountId, rows, options, true);
  const changes = summarise(result);
  const changeSet = {
    account_id: accountId,
    options,
    // The rows as given — a different file, or a different amount in one
    // row, is a different plan.
    rows: rows.map(r => [r.date, r.amount, r.imported_id ?? null, r.payee_name ?? null]),
    added: changes.added,
    updated: [...result.updated].sort(),
    unchanged: changes.unchanged,
  };
  return { changes, changeSet };
}

/** The real thing. Same call, one boolean different. */
export async function applyImport(
  lib: EngineLib,
  accountId: string,
  rows: ImportRow[],
  options: ImportOptions,
): Promise<ImportChanges & { added_ids: string[]; updated_ids: string[] }> {
  const result = await runImporter(lib, accountId, rows, options, false);
  return {
    ...summarise(result),
    added_ids: result.added,
    updated_ids: result.updated,
  };
}

export function assertUnderCeiling(changes: ImportChanges, maxChanges: number): void {
  const total = changes.added + changes.updated;
  if (total > maxChanges) {
    throw new MachineError(
      'invalid_input',
      `This import would change ${total} rows (${changes.added} added, ${changes.updated} updated), over the max_changes ceiling of ${maxChanges}.`,
      `pass max_changes: ${total} if that is what you intend`,
    );
  }
}

export async function resolveAccount(
  lib: EngineLib,
  accountId: string,
): Promise<{ id: string; name: string }> {
  const accounts = (await lib.send('api/accounts-get')) as Array<{ id: string; name: string }>;
  const found = accounts.find(a => a.id === accountId);
  if (!found) {
    throw new MachineError(
      'not_found',
      `No account with id ${accountId}.`,
      'GET /accounts lists the ids; POST /accounts creates one',
    );
  }
  return found;
}
