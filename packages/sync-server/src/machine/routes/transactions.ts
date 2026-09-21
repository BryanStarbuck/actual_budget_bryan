/**
 * Transactions — pm/apis.mdx §8.3 (the subset an import needs).
 *
 * `POST /transactions/import` is the JSON door to the importer
 * (import_formats.mdx §7). Rows are integer cents and YYYY-MM-DD; the
 * importer decides what is new (§8 there). dry_run defaults true.
 */
import { fingerprintOf, issueConfirm, redeemConfirm } from '#machine/confirm';
import { requireBudget } from '#machine/engine';
import { MachineError } from '#machine/envelope';
import {
  applyImport,
  assertUnderCeiling,
  DEFAULT_IMPORT_OPTIONS,
  previewImport,
  resolveAccount,
  validateRows,
} from '#machine/import-plan';
import type { ImportOptions } from '#machine/import-plan';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { MAX_CHANGES_DEFAULT, MAX_LIMIT } from '#machine/routes/plane';
import { fields } from '#machine/validate';

import { syncIfConnected } from './budgets.js';

type ListArgs = {
  account_id: string;
  start?: string;
  end?: string;
  limit?: number;
  offset?: number;
};

type ImportArgs = {
  account_id: string;
  transactions: unknown[];
  dry_run?: boolean;
  confirm_token?: string;
  max_changes?: number;
  reimport_deleted?: boolean;
  payee_name_normalization?: 'original' | 'title-case';
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function importOptionsFrom(args: {
  reimport_deleted?: boolean;
  payee_name_normalization?: 'original' | 'title-case';
}): ImportOptions {
  return {
    reimport_deleted: args.reimport_deleted ?? DEFAULT_IMPORT_OPTIONS.reimport_deleted,
    payee_name_normalization:
      args.payee_name_normalization ?? DEFAULT_IMPORT_OPTIONS.payee_name_normalization,
  };
}

export const transactionRoutes: AnyRouteDef[] = [
  route<ListArgs>({
    method: 'GET',
    path: '/transactions',
    tier: 'read',
    summary:
      'Transactions for one account over a date range, newest first, in integer cents. Split parents and children are both returned.',
    status: 'live',
    needsEngine: true,
    validate: fields<ListArgs>({
      account_id: { type: 'string', required: true },
      start: { type: 'string', maxLength: 10 },
      end: { type: 'string', maxLength: 10 },
      limit: { type: 'integer', min: 1 },
      offset: { type: 'integer', min: 0 },
    }),
    run: async ctx => {
      const { account_id, start, end, offset = 0 } = ctx.args;
      const limit = Math.min(ctx.args.limit ?? 1000, MAX_LIMIT);
      for (const [name, value] of [['start', start], ['end', end]] as const) {
        if (value !== undefined && !DATE.test(value)) {
          throw new MachineError('invalid_input', `${name} must be YYYY-MM-DD.`);
        }
      }
      const { lib, budget } = await requireBudget(ctx.env);
      await resolveAccount(lib, account_id);
      const rows = (await lib.send('api/transactions-get', {
        accountId: account_id,
        startDate: start,
        endDate: end,
      })) as unknown[];
      const page = rows.slice(offset, offset + limit);
      return {
        data: page,
        meta: {
          budgetId: budget.id,
          budgetName: budget.name,
          truncated: offset + limit < rows.length,
          limitApplied: limit,
          total: rows.length,
        },
      };
    },
  }),

  route<ImportArgs>({
    method: 'POST',
    path: '/transactions/import',
    tier: 'write',
    summary:
      "Import JSON rows through the app's own importer, which de-duplicates on imported_id then fuzzily. dry_run defaults true and returns the plan plus a confirm_token.",
    status: 'live',
    needsEngine: true,
    validate: fields<ImportArgs>({
      account_id: { type: 'string', required: true },
      transactions: { type: 'array', required: true, maxItems: 20000 },
      dry_run: { type: 'boolean' },
      confirm_token: { type: 'string' },
      max_changes: { type: 'integer', min: 1 },
      reimport_deleted: { type: 'boolean' },
      payee_name_normalization: { type: 'string', enum: ['original', 'title-case'] },
    }),
    run: async ctx => {
      const { account_id, dry_run = true, confirm_token } = ctx.args;
      const maxChanges = ctx.args.max_changes ?? MAX_CHANGES_DEFAULT;
      const options = importOptionsFrom(ctx.args);
      const rows = validateRows(ctx.args.transactions);
      const { lib, budget } = await requireBudget(ctx.env);
      const account = await resolveAccount(lib, account_id);
      const meta = { budgetId: budget.id, budgetName: budget.name };

      const preview = await previewImport(lib, account_id, rows, options);
      const fp = fingerprintOf(preview.changeSet);
      const base = {
        account,
        rows: rows.length,
        options,
        changes: preview.changes,
        max_changes: maxChanges,
      };
      if (dry_run) {
        assertUnderCeiling(preview.changes, maxChanges);
        return {
          data: { dry_run: true, ...base, ...issueConfirm('transactions.import', fp) },
          meta,
        };
      }
      redeemConfirm(confirm_token as string, 'transactions.import', fp, preview.changes);
      assertUnderCeiling(preview.changes, maxChanges);
      const result = await applyImport(lib, account_id, rows, options);
      const sync = await syncIfConnected(ctx.env);
      return {
        data: {
          dry_run: false,
          ...base,
          changes: { added: result.added, updated: result.updated, unchanged: result.unchanged, errors: result.errors },
          added_ids: result.added_ids,
          updated_ids: result.updated_ids,
          sync,
        },
        meta,
      };
    },
  }),
];
