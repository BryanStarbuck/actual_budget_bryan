/**
 * Accounts and transactions — pm/mcp.mdx §9.5.
 *
 * Six read tools. The one that needs care is ab_list_transactions, because
 * split transactions are the commonest way anybody gets a wrong number out of
 * a budget tool (§10, and cli.mdx §9).
 */
import { z } from 'zod';

import { clampLimit } from '../gates.js';

import { dateField, describe } from './tool.js';
import type { ToolDef } from './tool.js';

export const listAccounts: ToolDef = {
  name: 'ab_list_accounts',
  route: { method: 'GET', path: '/accounts' },
  tier: 'read',
  description: describe({
    what: 'Lists the operator\'s accounts with their current balances in integer cents. Closed accounts are excluded unless include_closed is true.',
    tier: 'read',
    insteadOf:
      'For one account\'s balance as of a past date, use ab_get_account_balance with as_of.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      include_closed: {
        type: 'boolean',
        description: 'Include closed accounts. Defaults to false.',
      },
    },
    additionalProperties: false,
  },
  schema: z.object({ include_closed: z.boolean().optional() }).strip(),
  async run(args, ctx) {
    const { include_closed } = args as { include_closed?: boolean };
    const res = await ctx.client.request('/accounts', {
      query: { include_closed: include_closed ?? false },
    });
    return { data: res.data, untrusted: ['name'] };
  },
};

export const getAccount: ToolDef = {
  name: 'ab_get_account',
  route: { method: 'GET', path: '/accounts/:id' },
  tier: 'read',
  description: describe({
    what: 'Gets one account by id: its name, type, closed state and current balance in integer cents.',
    tier: 'read',
    insteadOf: 'To find an id, use ab_list_accounts.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      account_id: {
        type: 'string',
        description: 'The account id, as returned by ab_list_accounts.',
      },
    },
    required: ['account_id'],
    additionalProperties: false,
  },
  schema: z.object({ account_id: z.string().min(1) }).strip(),
  async run(args, ctx) {
    const { account_id } = args as { account_id: string };
    const res = await ctx.client.request(
      `/accounts/${encodeURIComponent(account_id)}`,
    );
    return { data: res.data, untrusted: ['name'] };
  },
};

export const getAccountBalance: ToolDef = {
  name: 'ab_get_account_balance',
  route: { method: 'GET', path: '/accounts/:id/balance' },
  tier: 'read',
  description: describe({
    what: 'Gets one account\'s balance in integer cents, optionally as of a past date. The answer carries the cutoff it was computed against.',
    tier: 'read',
    insteadOf:
      'Do not sum transactions to get a balance — this is the app\'s own figure and the two will differ on splits.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'The account id.' },
      as_of: dateField(
        'Compute the balance as of the end of this date. Defaults to now.',
      ),
    },
    required: ['account_id'],
    additionalProperties: false,
  },
  schema: z
    .object({
      account_id: z.string().min(1),
      as_of: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
        .optional(),
    })
    .strip(),
  async run(args, ctx) {
    const { account_id, as_of } = args as {
      account_id: string;
      as_of?: string;
    };
    const res = await ctx.client.request(
      `/accounts/${encodeURIComponent(account_id)}/balance`,
      { query: { as_of } },
    );
    return { data: res.data };
  },
};

export const listTransactions: ToolDef = {
  name: 'ab_list_transactions',
  route: { method: 'GET', path: '/transactions' },
  tier: 'read',
  description: describe({
    what: 'Lists transactions for one account over a date range, with optional category, payee and cleared filters. Amounts are integer cents; rows carry is_parent and is_child so split transactions are visible.',
    tier: 'read',
    insteadOf:
      'Do NOT sum these rows to get a total — a split parent and its children are all returned and adding the column counts the same money twice. Use ab_get_category_spend or ab_get_account_balance instead.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      account_id: { type: 'string', description: 'The account id.' },
      start: dateField('Earliest transaction date to include.'),
      end: dateField('Latest transaction date to include.'),
      category_id: {
        type: 'string',
        description: 'Only transactions in this category.',
      },
      payee_id: {
        type: 'string',
        description: 'Only transactions for this payee.',
      },
      cleared: {
        type: 'boolean',
        description:
          'Only cleared (true) or only uncleared (false) transactions.',
      },
      limit: {
        type: 'integer',
        description:
          'Maximum rows to return. Values above the server cap are clamped, and the reply says so rather than failing.',
      },
    },
    required: ['account_id'],
    additionalProperties: false,
  },
  schema: z
    .object({
      account_id: z.string().min(1),
      start: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      end: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      category_id: z.string().optional(),
      payee_id: z.string().optional(),
      cleared: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    })
    .strip(),
  async run(args, ctx) {
    const a = args as {
      account_id: string;
      start?: string;
      end?: string;
      category_id?: string;
      payee_id?: string;
      cleared?: boolean;
      limit?: number;
    };
    const { limit, clamped } = clampLimit(a.limit, ctx.config);

    const res = await ctx.client.request('/transactions', {
      query: {
        account_id: a.account_id,
        start: a.start,
        end: a.end,
        category_id: a.category_id,
        payee_id: a.payee_id,
        cleared: a.cleared,
        limit,
      },
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    return {
      data: res.data,
      untrusted: ['payee', 'imported_payee', 'notes'],
      truncated: clamped || rows.length >= limit,
      limitApplied: limit,
    };
  },
};

export const getTransaction: ToolDef = {
  name: 'ab_get_transaction',
  route: { method: 'GET', path: '/transactions/:id' },
  tier: 'read',
  description: describe({
    what: 'Gets one transaction by id, including its split children if it is a split parent. Amounts are integer cents.',
    tier: 'read',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      transaction_id: { type: 'string', description: 'The transaction id.' },
    },
    required: ['transaction_id'],
    additionalProperties: false,
  },
  schema: z.object({ transaction_id: z.string().min(1) }).strip(),
  async run(args, ctx) {
    const { transaction_id } = args as { transaction_id: string };
    const res = await ctx.client.request(
      `/transactions/${encodeURIComponent(transaction_id)}`,
    );
    return { data: res.data, untrusted: ['payee', 'imported_payee', 'notes'] };
  },
};

export const listUncategorized: ToolDef = {
  name: 'ab_list_uncategorized',
  route: { method: 'GET', path: '/transactions/uncategorized' },
  tier: 'read',
  description: describe({
    what: 'Lists every transaction with no category assigned, across all accounts — the commonest real question an operator has about their budget.',
    tier: 'read',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      limit: {
        type: 'integer',
        description:
          'Maximum rows. Clamped to the server cap, which is reported.',
      },
    },
    additionalProperties: false,
  },
  schema: z.object({ limit: z.number().int().positive().optional() }).strip(),
  async run(args, ctx) {
    const { limit: requested } = args as { limit?: number };
    const { limit, clamped } = clampLimit(requested, ctx.config);

    const res = await ctx.client.request('/transactions/uncategorized', {
      query: { limit },
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    return {
      data: res.data,
      untrusted: ['payee', 'imported_payee', 'notes'],
      truncated: clamped || rows.length >= limit,
      limitApplied: limit,
    };
  },
};

export const ACCOUNT_TOOLS = [listAccounts, getAccount, getAccountBalance];
export const TRANSACTION_TOOLS = [
  listTransactions,
  getTransaction,
  listUncategorized,
];
