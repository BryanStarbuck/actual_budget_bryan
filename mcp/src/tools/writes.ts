/**
 * The write tier — pm/mcp.mdx §9.5, §9.7.
 *
 * Four tools here plus ab_apply_statement_import in statements.ts: five in
 * total, and every one of them changes money that syncs to the operator's
 * phone.
 *
 * What is deliberately ABSENT is as much of the design as what is present.
 * There is no ab_delete_transaction, no ab_delete_account, no
 * ab_close_account, and no rule/schedule/category writer. The machine plane
 * has routes for some of these; this catalogue does not expose them.
 * Deleting somebody's financial records is a human act in a UI that can show
 * them what is about to go — and the catalogue is the boundary, so a model
 * asked to "clean up duplicates" finds no tool and reports that instead of
 * improvising.
 */
import { z } from 'zod';

import { cents, centsField, describe, monthField } from './tool.js';
import type { ToolDef } from './tool.js';

/** Every write tool carries these, and the host enforces them (§9.7). */
const CONFIRM_FIELDS = {
  confirm: {
    type: 'string',
    description:
      'The confirm_token from the matching plan_ call. Required to change anything.',
  },
  dry_run: {
    type: 'boolean',
    description:
      'Defaults to TRUE. Must be explicitly false to change anything.',
  },
  max_changes: {
    type: 'integer',
    description:
      'Refuse if more rows than this would change. The refusal reports the real number.',
  },
} as const;

const confirmSchema = {
  confirm: z.string().optional(),
  dry_run: z.boolean().optional(),
  max_changes: z.number().int().positive().optional(),
};

export const addTransactions: ToolDef = {
  name: 'ab_add_transactions',
  route: { method: 'POST', path: '/transactions' },
  tier: 'write',
  description: describe({
    what: 'Adds one or more transactions to a single account. Amounts are integer cents; negative is money out.',
    tier: 'write',
    insteadOf:
      'For importing bank statements use the statements tools, which de-duplicate. This tool adds rows unconditionally and will happily create a duplicate of something already there.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'The account to add to.' },
      transactions: {
        type: 'array',
        description: 'The transactions to add.',
        items: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'Transaction date, YYYY-MM-DD.',
            },
            amount: centsField(
              'The transaction amount. Negative is money out.',
            ),
            payee_name: { type: 'string', description: 'The payee name.' },
            notes: { type: 'string', description: 'A note for the operator.' },
            category_id: { type: 'string', description: 'Category to assign.' },
          },
          required: ['date', 'amount'],
          additionalProperties: false,
        },
      },
      ...CONFIRM_FIELDS,
    },
    required: ['account_id', 'transactions'],
    additionalProperties: false,
  },
  schema: z
    .object({
      account_id: z.string().min(1),
      transactions: z
        .array(
          z
            .object({
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              // The money rule at the gate: a model asked for "about $123"
              // produces 123.5, and this is where that stops — with a message
              // naming the integer it meant.
              amount: cents(),
              payee_name: z.string().optional(),
              notes: z.string().optional(),
              category_id: z.string().optional(),
            })
            .strip(),
        )
        .min(1),
      ...confirmSchema,
    })
    .strip(),
  async run(args, ctx) {
    const a = args as Record<string, unknown> & {
      dry_run?: boolean;
      max_changes?: number;
    };
    const res = await ctx.client.request('/transactions', {
      method: 'POST',
      body: {
        ...a,
        dry_run: a.dry_run ?? true,
        max_changes: a.max_changes ?? ctx.config.maxChanges,
      },
    });
    return { data: res.data };
  },
};

export const updateTransaction: ToolDef = {
  name: 'ab_update_transaction',
  route: { method: 'PATCH', path: '/transactions/:id' },
  tier: 'write',
  description: describe({
    what: 'Updates fields on one existing transaction — its category, notes, payee, cleared state or amount in integer cents.',
    tier: 'write',
    insteadOf:
      'To see the transaction first, use ab_get_transaction. There is no tool to delete one; that is the operator\'s to do in the app.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: {
        type: 'string',
        description: 'The transaction to update.',
      },
      fields: {
        type: 'object',
        description: 'The fields to change. Omitted fields are left alone.',
        properties: {
          category_id: { type: 'string', description: 'New category.' },
          notes: { type: 'string', description: 'New note.' },
          payee_name: { type: 'string', description: 'New payee.' },
          cleared: { type: 'boolean', description: 'New cleared state.' },
          amount: centsField('New amount.'),
        },
        additionalProperties: false,
      },
      ...CONFIRM_FIELDS,
    },
    required: ['transaction_id', 'fields'],
    additionalProperties: false,
  },
  schema: z
    .object({
      transaction_id: z.string().min(1),
      fields: z
        .object({
          category_id: z.string().optional(),
          notes: z.string().optional(),
          payee_name: z.string().optional(),
          cleared: z.boolean().optional(),
          amount: cents().optional(),
        })
        .strip(),
      ...confirmSchema,
    })
    .strip(),
  async run(args, ctx) {
    const a = args as Record<string, unknown> & {
      transaction_id: string;
      dry_run?: boolean;
    };
    const res = await ctx.client.request(
      `/transactions/${encodeURIComponent(a.transaction_id)}`,
      {
        method: 'PATCH',
        body: { ...a, dry_run: a.dry_run ?? true },
      },
    );
    return { data: res.data };
  },
};

export const setBudgetAmount: ToolDef = {
  name: 'ab_set_budget_amount',
  route: { method: 'PATCH', path: '/budget/month/:month/category/:id' },
  tier: 'write',
  description: describe({
    what: 'Sets the budgeted amount, in integer cents, for one category in one month.',
    tier: 'write',
    insteadOf:
      'Read the month with ab_get_budget_month first. Setting an amount of 0 is NOT the same as leaving a category unbudgeted, and this tool cannot restore the unbudgeted state.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      month: monthField('The budget month to change.'),
      category_id: {
        type: 'string',
        description: 'The category to budget for.',
      },
      amount: centsField('The amount to budget.'),
      ...CONFIRM_FIELDS,
    },
    required: ['month', 'category_id', 'amount'],
    additionalProperties: false,
  },
  schema: z
    .object({
      month: z.string().regex(/^\d{4}-\d{2}$/),
      category_id: z.string().min(1),
      amount: cents(),
      ...confirmSchema,
    })
    .strip(),
  async run(args, ctx) {
    const a = args as Record<string, unknown> & {
      month: string;
      category_id: string;
      dry_run?: boolean;
    };
    const res = await ctx.client.request(
      `/budget/month/${encodeURIComponent(a.month)}/category/${encodeURIComponent(a.category_id)}`,
      { method: 'PATCH', body: { ...a, dry_run: a.dry_run ?? true } },
    );
    return { data: res.data };
  },
};

export const sync: ToolDef = {
  name: 'ab_sync',
  route: { method: 'POST', path: '/sync' },
  tier: 'write',
  description: describe({
    what: 'Syncs this budget with the operator\'s sync server, pushing local changes and pulling any made on their other devices.',
    tier: 'write',
    insteadOf:
      'Run this after a write if the operator wants the change on their phone immediately.',
  }),
  // No dry_run: a sync has nothing to preview, so the schema does not offer
  // one rather than accepting a flag it would ignore (§9.6).
  inputSchema: {
    type: 'object',
    properties: {
      confirm: CONFIRM_FIELDS.confirm,
    },
    additionalProperties: false,
  },
  schema: z.object({ confirm: z.string().optional() }).strip(),
  async run(_args, ctx) {
    const res = await ctx.client.request('/sync', {
      method: 'POST',
      noTimeout: true,
    });
    return { data: res.data };
  },
};

export const WRITE_TOOLS = [
  addTransactions,
  updateTransaction,
  setBudgetAmount,
  sync,
];
