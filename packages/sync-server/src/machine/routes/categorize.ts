/**
 * Categorise already-imported rows by their import id — pm/apis.mdx §8.3a.
 *
 * The import pipeline writes rows with an `imported_id` (the OFX FITID) and
 * no category. Categorising them afterwards by transaction id means first
 * listing thousands of rows to learn ids the caller already has a better key
 * for: the account plus the FITID it put in the file. These two routes take
 * that key and change ONE field — `category` — on rows that already exist.
 *
 * Shaped like reconcile and account provisioning (§8.2, §12): a read-tier
 * `plan` that returns every row's outcome and a confirm_token, and a
 * write-tier `apply` that recomputes the plan from the token's payload and
 * refuses if it moved. The plan is read-tier so an agent can show the
 * operator what would change without the write switches being on.
 *
 * What this never does, each on purpose:
 *
 *   - Never creates a category. An unknown "Group > Category" is reported as
 *     unknown_category with nothing written for that row (§7.6 — never invent
 *     a value). Creating categories is a deliberate act with its own route.
 *   - Never adds, deletes or re-dates a row, and never touches any field but
 *     `category`. A row that is not found is reported, not imported.
 *   - Never guesses between two matches. An imported_id that matches two rows
 *     in one account, a bare category name that exists in two groups, or an
 *     account name shared by two accounts is reported as ambiguous.
 *   - Never categorises a split parent (the category lives on its children)
 *     or a transfer (the app decides whether a transfer carries a category,
 *     from which accounts it joins). Both are reported for the operator.
 */
import {
  fingerprintOf,
  issueConfirm,
  peekConfirm,
  redeemConfirm,
} from '#machine/confirm';
import type { EngineLib } from '#machine/engine';
import { requireBudget } from '#machine/engine';
import { MachineError } from '#machine/envelope';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { categoryGroups } from '#machine/routes/categories';
import type { ApiCategoryGroup } from '#machine/routes/categories';
import { MAX_CHANGES_DEFAULT } from '#machine/routes/plane';
import { fields } from '#machine/validate';

import { syncIfConnected } from './budgets.js';

type Assignment = { account: string; imported_id: string; category: string };

type PlanArgs = { assignments: unknown[]; max_changes?: number };
type Payload = { assignments: Assignment[]; max_changes: number };

type RowStatus =
  | 'change'
  | 'unchanged'
  | 'not_found'
  | 'unknown_account'
  | 'ambiguous_account'
  | 'unknown_category'
  | 'ambiguous_category'
  | 'ambiguous_row'
  | 'split_parent'
  | 'transfer'
  | 'duplicate_assignment';

type CategoryRef = { id: string; path: string; hidden: boolean };

type PlanRow = {
  index: number;
  status: RowStatus;
  account: string;
  account_id?: string;
  imported_id: string;
  category: string;
  transaction_id?: string;
  date?: string;
  amount?: number;
  from?: CategoryRef | null;
  to?: CategoryRef;
  reason?: string;
  candidates?: string[];
};

type ApiAccount = { id: string; name: string };

type ApiTransaction = {
  id: string;
  date: string;
  amount: number;
  category?: string | null;
  imported_id?: string | null;
  is_parent?: boolean;
  transfer_id?: string | null;
};

const COUNT_KEYS = [
  'change',
  'unchanged',
  'not_found',
  'unknown_account',
  'ambiguous_account',
  'unknown_category',
  'ambiguous_category',
  'ambiguous_row',
  'split_parent',
  'transfer',
  'duplicate_assignment',
] as const satisfies readonly RowStatus[];

/** Case- and whitespace-insensitive, so "food > groceries" finds "Food > Groceries". */
function norm(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Gate 5 for the assignments themselves. Every failure names the index and
 * the field, because "category is required" over 3,000 rows is not a hint.
 */
function validateAssignments(raw: unknown[]): Assignment[] {
  const allowed = ['account', 'imported_id', 'category'];
  return raw.map((item, i) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new MachineError(
        'invalid_input',
        `assignments[${i}] must be an object.`,
      );
    }
    const obj = item as Record<string, unknown>;
    const unknown = Object.keys(obj).filter(k => !allowed.includes(k));
    if (unknown.length > 0) {
      throw new MachineError(
        'invalid_input',
        `assignments[${i}] has unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
        `each assignment accepts: ${allowed.join(', ')}`,
      );
    }
    for (const name of allowed) {
      if (
        typeof obj[name] !== 'string' ||
        (obj[name] as string).trim() === ''
      ) {
        throw new MachineError(
          'invalid_input',
          `assignments[${i}].${name} must be a non-empty string.`,
          name === 'category'
            ? 'pass "Group > Category" or a category id from GET /categories/tree'
            : name === 'account'
              ? 'pass the account id or its exact name from GET /accounts'
              : 'pass the imported_id (the OFX FITID) the row was imported with',
        );
      }
    }
    return {
      account: obj.account as string,
      imported_id: obj.imported_id as string,
      category: obj.category as string,
    };
  });
}

type CategoryIndex = {
  byId: Map<string, CategoryRef>;
  groups: ApiCategoryGroup[];
};

function indexCategories(groups: ApiCategoryGroup[]): CategoryIndex {
  const all: CategoryRef[] = [];
  for (const g of groups) {
    for (const c of g.categories ?? []) {
      all.push({
        id: c.id,
        path: `${g.name} > ${c.name}`,
        hidden: Boolean(c.hidden || g.hidden),
      });
    }
  }
  return { byId: new Map(all.map(c => [c.id, c])), groups };
}

type Resolved =
  | { ok: true; category: CategoryRef }
  | {
      ok: false;
      status: 'unknown_category' | 'ambiguous_category';
      candidates?: string[];
    };

/**
 * An id, a "Group > Category" path, or a bare category name that is unique
 * across groups. Every `>` is tried as the separator, so a group whose own
 * name contains `>` still resolves; two readings that both match is ambiguous.
 */
function resolveCategory(index: CategoryIndex, input: string): Resolved {
  const byId = index.byId.get(input.trim());
  if (byId) {
    return { ok: true, category: byId };
  }

  const matches = new Map<string, CategoryRef>();
  if (input.includes('>')) {
    for (
      let at = input.indexOf('>');
      at !== -1;
      at = input.indexOf('>', at + 1)
    ) {
      const group = norm(input.slice(0, at));
      const name = norm(input.slice(at + 1));
      for (const g of index.groups) {
        if (norm(g.name) !== group) {
          continue;
        }
        for (const c of g.categories ?? []) {
          if (norm(c.name) === name) {
            const ref = index.byId.get(c.id);
            if (ref) matches.set(ref.id, ref);
          }
        }
      }
    }
  } else {
    for (const g of index.groups) {
      for (const c of g.categories ?? []) {
        if (norm(c.name) === norm(input)) {
          const ref = index.byId.get(c.id);
          if (ref) matches.set(ref.id, ref);
        }
      }
    }
  }

  const found = [...matches.values()];
  if (found.length === 1) {
    return { ok: true, category: found[0] };
  }
  if (found.length > 1) {
    return {
      ok: false,
      status: 'ambiguous_category',
      candidates: found.map(c => c.path),
    };
  }
  return { ok: false, status: 'unknown_category' };
}

function resolveAccountRef(
  accounts: ApiAccount[],
  input: string,
):
  | { ok: true; account: ApiAccount }
  | {
      ok: false;
      status: 'unknown_account' | 'ambiguous_account';
      candidates?: string[];
    } {
  const byId = accounts.find(a => a.id === input.trim());
  if (byId) {
    return { ok: true, account: byId };
  }
  const named = accounts.filter(a => norm(a.name) === norm(input));
  if (named.length === 1) {
    return { ok: true, account: named[0] };
  }
  if (named.length > 1) {
    return {
      ok: false,
      status: 'ambiguous_account',
      candidates: named.map(a => `${a.name} (${a.id})`),
    };
  }
  return { ok: false, status: 'unknown_account' };
}

async function plan(
  env: NodeJS.ProcessEnv,
  payload: Payload,
): Promise<{
  lib: EngineLib;
  meta: Record<string, unknown>;
  rows: PlanRow[];
  counts: Record<string, number>;
  fp: string;
}> {
  const { lib, budget } = await requireBudget(env);
  // Hidden categories count: a row filed under a hidden category is still
  // filed, and refusing it would be the plane deciding what is visible.
  const index = indexCategories(await categoryGroups(lib, true));
  const accounts = (await lib.send('api/accounts-get')) as ApiAccount[];

  // One read per account, keyed by imported_id. Top-level rows only: the
  // importer stamps imported_id on the row it created, never on a child.
  const ledgers = new Map<string, Map<string, ApiTransaction[]>>();
  async function ledgerFor(
    accountId: string,
  ): Promise<Map<string, ApiTransaction[]>> {
    let ledger = ledgers.get(accountId);
    if (!ledger) {
      ledger = new Map();
      const txns = (await lib.send('api/transactions-get', {
        accountId,
      })) as ApiTransaction[];
      for (const t of txns) {
        if (t.imported_id) {
          const list = ledger.get(t.imported_id) ?? [];
          list.push(t);
          ledger.set(t.imported_id, list);
        }
      }
      ledgers.set(accountId, ledger);
    }
    return ledger;
  }

  const seen = new Set<string>();
  const rows: PlanRow[] = [];
  for (const [i, a] of payload.assignments.entries()) {
    const base = {
      index: i,
      account: a.account,
      imported_id: a.imported_id,
      category: a.category,
    };

    const acct = resolveAccountRef(accounts, a.account);
    if ('status' in acct) {
      rows.push({ ...base, status: acct.status, candidates: acct.candidates });
      continue;
    }
    const key = `${acct.account.id}\u0000${a.imported_id}`;
    if (seen.has(key)) {
      rows.push({
        ...base,
        account_id: acct.account.id,
        status: 'duplicate_assignment',
        reason:
          'an earlier assignment already names this account and imported_id; only the first is used',
      });
      continue;
    }
    seen.add(key);

    const cat = resolveCategory(index, a.category);
    if ('status' in cat) {
      rows.push({
        ...base,
        account_id: acct.account.id,
        status: cat.status,
        candidates: cat.candidates,
        reason:
          cat.status === 'unknown_category'
            ? 'no such category — nothing is created; add it in the app or pick one from GET /categories/tree'
            : 'the name exists in more than one group — pass "Group > Category" or the id',
      });
      continue;
    }

    const matches = (await ledgerFor(acct.account.id)).get(a.imported_id) ?? [];
    if (matches.length === 0) {
      rows.push({
        ...base,
        account_id: acct.account.id,
        status: 'not_found',
        to: cat.category,
        reason:
          'no row in this account carries that imported_id — import the statement first',
      });
      continue;
    }
    if (matches.length > 1) {
      rows.push({
        ...base,
        account_id: acct.account.id,
        status: 'ambiguous_row',
        to: cat.category,
        candidates: matches.map(t => t.id),
        reason: `${matches.length} rows in this account carry that imported_id`,
      });
      continue;
    }

    const t = matches[0];
    const from = t.category
      ? (index.byId.get(t.category) ?? {
          id: t.category,
          path: '(unknown category)',
          hidden: false,
        })
      : null;
    const found = {
      ...base,
      account_id: acct.account.id,
      transaction_id: t.id,
      date: t.date,
      amount: t.amount,
      from,
      to: cat.category,
    };
    if (t.is_parent) {
      rows.push({
        ...found,
        status: 'split_parent',
        reason:
          'a split parent carries no category; categorise its children in the app',
      });
    } else if (t.transfer_id) {
      rows.push({
        ...found,
        status: 'transfer',
        reason:
          'a transfer is categorised by the app from the accounts it joins; change it in the app',
      });
    } else if (from?.id === cat.category.id) {
      rows.push({ ...found, status: 'unchanged' });
    } else {
      rows.push({ ...found, status: 'change' });
    }
  }

  const tally: Record<string, number> = Object.fromEntries(
    COUNT_KEYS.map(k => [k, 0]),
  );
  for (const r of rows) {
    tally[r.status] += 1;
  }
  const counts = {
    rows: rows.length,
    matched:
      tally.change + tally.unchanged + tally.split_parent + tally.transfer,
    changed: tally.change,
    unchanged: tally.unchanged,
    not_found: tally.not_found,
    unknown_account: tally.unknown_account,
    ambiguous_account: tally.ambiguous_account,
    unknown_category: tally.unknown_category,
    ambiguous_category: tally.ambiguous_category,
    ambiguous_row: tally.ambiguous_row,
    split_parent: tally.split_parent,
    transfer: tally.transfer,
    duplicate_assignment: tally.duplicate_assignment,
  };

  // The token fingerprints the writes the caller was shown — which row, from
  // which category, to which — so a row re-categorised in the browser after
  // the plan refuses the apply rather than being silently overwritten.
  const fp = fingerprintOf(
    rows
      .filter(r => r.status === 'change')
      .map(r => [r.transaction_id, r.from?.id ?? null, r.to?.id]),
  );
  return {
    lib,
    meta: { budgetId: budget.id, budgetName: budget.name },
    rows,
    counts,
    fp,
  };
}

function assertUnderLimit(changed: number, maxChanges: number): void {
  if (changed > maxChanges) {
    throw new MachineError(
      'invalid_input',
      `This would re-categorise ${changed} rows, over the max_changes ceiling of ${maxChanges}.`,
      `pass max_changes: ${changed} to the plan if that is what you intend`,
    );
  }
}

export const categorizeRoutes: AnyRouteDef[] = [
  route<PlanArgs>({
    method: 'POST',
    path: '/transactions/categorize-by-import/plan',
    tier: 'read',
    summary:
      'For each {account, imported_id, category}: find the already-imported row and say whether its category would change, with counts and a per-row reason. Never creates a category. Returns a confirm_token for apply.',
    status: 'live',
    needsEngine: true,
    validate: fields<PlanArgs>({
      assignments: { type: 'array', required: true, maxItems: 20000 },
      max_changes: { type: 'integer', min: 1 },
    }),
    run: async ctx => {
      const payload: Payload = {
        assignments: validateAssignments(ctx.args.assignments),
        max_changes: ctx.args.max_changes ?? MAX_CHANGES_DEFAULT,
      };
      const result = await plan(ctx.env, payload);
      return {
        data: {
          dry_run: true,
          counts: result.counts,
          max_changes: payload.max_changes,
          // Said now rather than discovered at apply: the apply refuses over it.
          within_max_changes: result.counts.changed <= payload.max_changes,
          rows: result.rows,
          ...issueConfirm(
            'transactions.categorize_by_import',
            result.fp,
            payload,
          ),
        },
        meta: result.meta,
      };
    },
  }),

  route<{ confirm_token: string; dry_run?: boolean }>({
    method: 'POST',
    path: '/transactions/categorize-by-import/apply',
    tier: 'write',
    summary:
      'Set the category on the rows a plan token was issued for, and nothing else. The plan is recomputed and must match. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<{ confirm_token: string; dry_run?: boolean }>({
      confirm_token: { type: 'string', required: true },
      dry_run: { type: 'boolean' },
    }),
    run: async ctx => {
      const { confirm_token, dry_run = true } = ctx.args;
      const entry = peekConfirm(
        confirm_token,
        'transactions.categorize_by_import',
      );
      const payload = entry.payload as Payload;
      const result = await plan(ctx.env, payload);
      if (dry_run) {
        return {
          data: {
            dry_run: true,
            counts: result.counts,
            max_changes: payload.max_changes,
            rows: result.rows,
            confirm_token,
            fingerprint: result.fp,
          },
          meta: result.meta,
        };
      }
      redeemConfirm(
        confirm_token,
        'transactions.categorize_by_import',
        result.fp,
        result.counts,
      );
      assertUnderLimit(result.counts.changed, payload.max_changes);

      // Each change carries the category it replaced, so the operator can
      // put any row back by hand until POST /undo exists (§7.5, phase P3).
      const changed: Array<{
        transaction_id: string;
        from: CategoryRef | null;
        to: CategoryRef;
      }> = [];
      for (const r of result.rows) {
        if (r.status !== 'change' || !r.transaction_id || !r.to) {
          continue;
        }
        await result.lib.send('api/transaction-update', {
          id: r.transaction_id,
          fields: { category: r.to.id },
        });
        changed.push({
          transaction_id: r.transaction_id,
          from: r.from ?? null,
          to: r.to,
        });
      }
      const sync = await syncIfConnected(ctx.env);
      return {
        data: {
          dry_run: false,
          counts: result.counts,
          changed,
          skipped: result.rows.filter(
            r => r.status !== 'change' && r.status !== 'unchanged',
          ),
          sync,
        },
        meta: result.meta,
      };
    },
  }),
];
