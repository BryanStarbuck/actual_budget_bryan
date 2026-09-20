/**
 * Reference data and the query escape hatch — pm/mcp.mdx §9.5, §7.4.
 *
 * Four plain list tools, plus ab_query and its schema describer. The query
 * hatch is guarded SERVER-SIDE; the checks here exist only to produce a better
 * message before a round trip, and the server repeats every one of them,
 * because a client-side check the server does not repeat is a hole.
 */
import { z } from 'zod';

import { fail } from '../envelope.js';
import { clampLimit } from '../gates.js';

import { describe } from './tool.js';
import type { ToolDef } from './tool.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const noArgs = z.object({}).strip();

function listTool(
  name: string,
  route: string,
  what: string,
  untrusted: string[],
): ToolDef {
  return {
    name,
    tier: 'read',
    description: describe({ what, tier: 'read' }),
    inputSchema: NO_ARGS,
    schema: noArgs,
    async run(_args, ctx) {
      const res = await ctx.client.request(route);
      return { data: res.data, untrusted };
    },
  };
}

export const listPayees = listTool(
  'ab_list_payees',
  '/payees',
  'Lists the payees in this budget — the businesses and people the operator transacts with.',
  ['name'],
);

export const listTags = listTool(
  'ab_list_tags',
  '/tags',
  'Lists the tags defined in this budget.',
  ['name'],
);

export const listRules = listTool(
  'ab_list_rules',
  '/rules',
  'Lists the rules that automatically categorise and modify transactions on import.',
  ['name', 'value'],
);

export const listSchedules = listTool(
  'ab_list_schedules',
  '/schedules',
  'Lists the scheduled transactions in this budget, with their next due dates and amounts in integer cents.',
  ['name'],
);

/**
 * Tables ab_query may name.
 *
 * The denylist is the server's; this is the allowlist we advertise, so the
 * model does not guess a table name, get a `forbidden`, and try three more.
 */
const QUERYABLE_TABLES = [
  'transactions',
  'accounts',
  'categories',
  'category_groups',
  'payees',
  'schedules',
  'rules',
] as const;

export const describeSchema: ToolDef = {
  name: 'ab_describe_schema',
  tier: 'read',
  description: describe({
    what: 'Describes the tables and fields ab_query may name, so a query can be written without guessing.',
    tier: 'read',
    insteadOf: 'Call this before ab_query rather than trying table names.',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/query/schema');
    return { data: res.data };
  },
};

export const query: ToolDef = {
  name: 'ab_query',
  tier: 'read',
  description: describe({
    what: 'Runs one read-only ActualQL query against the budget, for questions the typed tools do not cover. Single statement, row-capped, byte-capped and timed out. Amounts come back in integer cents.',
    tier: 'read',
    insteadOf:
      'Prefer a typed tool whenever one fits — ab_get_budget_month, ab_get_category_spend and ab_list_transactions are clearer and cannot be mis-scoped. Call ab_describe_schema first if you are unsure of a field name.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      table: {
        type: 'string',
        enum: [...QUERYABLE_TABLES],
        description: 'The table to query.',
      },
      select: {
        type: 'array',
        items: { type: 'string' },
        description: 'Field names to return. Omit for the default projection.',
      },
      filter: {
        type: 'object',
        description:
          'An ActualQL filter object, for example {"date": {"$gte": "2026-01-01"}}.',
        additionalProperties: true,
      },
      limit: {
        type: 'integer',
        description:
          'Maximum rows. Clamped to the server cap, which is reported.',
      },
    },
    required: ['table'],
    additionalProperties: false,
  },
  schema: z
    .object({
      table: z.enum(QUERYABLE_TABLES),
      select: z.array(z.string()).optional(),
      filter: z.record(z.string(), z.unknown()).optional(),
      limit: z.number().int().positive().optional(),
    })
    .strip(),
  async run(args, ctx) {
    const a = args as {
      table: string;
      select?: string[];
      filter?: Record<string, unknown>;
      limit?: number;
    };

    // A better message before the round trip. The server refuses this too.
    if (a.select?.some(field => field.includes('*'))) {
      throw fail(
        'invalid_input',
        'ab_query does not accept a wildcard projection.',
        'name the fields you need, or omit select for the default projection',
      );
    }

    const { limit, clamped } = clampLimit(a.limit, ctx.config);
    const res = await ctx.client.request('/query', {
      method: 'POST',
      body: {
        table: a.table,
        select: a.select,
        filter: a.filter,
        limit,
      },
    });

    const rows = Array.isArray(res.data) ? res.data : [];
    return {
      data: res.data,
      untrusted: ['payee', 'imported_payee', 'notes', 'name'],
      truncated: clamped || rows.length >= limit,
      limitApplied: limit,
    };
  },
};

export const REFERENCE_TOOLS = [listPayees, listTags, listRules, listSchedules];

export const QUERY_TOOLS = [query, describeSchema];
