/**
 * Categories and the budget — pm/mcp.mdx §9.5, §10.2.
 *
 * This family carries the rule with a section of its own: a category with NO
 * budget entry is not a category budgeted zero. `budgeted: null` survives
 * every layer here and is never coerced to 0, because a model that receives 0
 * answers "yes, zero" to "did I budget for groceries?" — confident, fluent,
 * and wrong about the operator's own intent, with nothing in the transcript
 * to reveal it.
 *
 * ab_get_category_tree is the one tool here whose answer is also a document:
 * the server's YAML rendering of the tree, sent verbatim beside the envelope.
 */
import { z } from 'zod';

import { dateField, describe, monthField } from './tool.js';
import type { ToolDef } from './tool.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const noArgs = z.object({}).strip();

export const listCategories: ToolDef = {
  name: 'ab_list_categories',
  route: { method: 'GET', path: '/categories' },
  tier: 'read',
  description: describe({
    what: "Lists the operator's budget categories with their ids, names and group membership.",
    tier: 'read',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/categories');
    return { data: res.data, untrusted: ['name'] };
  },
};

export const listCategoryGroups: ToolDef = {
  name: 'ab_list_category_groups',
  route: { method: 'GET', path: '/category-groups' },
  tier: 'read',
  description: describe({
    what: 'Lists the category groups that organise the budget, with the categories in each.',
    tier: 'read',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/category-groups');
    return { data: res.data, untrusted: ['name'] };
  },
};

export const getCategoryTree: ToolDef = {
  name: 'ab_get_category_tree',
  route: { method: 'GET', path: '/categories/tree' },
  tier: 'read',
  description: describe({
    what: 'Gets every category group with its categories nested, in the order the budget shows them, as a YAML document (the same shape ezBookkeeping and Firefly III use) plus the structured tree with every id.',
    tier: 'read',
    insteadOf:
      'Read this BEFORE categorising anything, and pick categories only from it. A category that is not in the tree does not exist; no tool here creates one.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      include_hidden: {
        type: 'boolean',
        description:
          'Include hidden groups and categories. Defaults to false — hidden ones are retired and should not receive new rows.',
      },
    },
    additionalProperties: false,
  },
  schema: z.object({ include_hidden: z.boolean().optional() }).strip(),
  async run(args, ctx) {
    const { include_hidden } = args as { include_hidden?: boolean };
    const res = await ctx.client.request('/categories/tree', {
      query: { include_hidden: include_hidden ?? false },
    });
    // The server built both the tree and its YAML. The YAML travels as its
    // own text block so the model reads it verbatim; it is lifted out of
    // `data` rather than sent twice. Nothing else is touched.
    const { yaml, ...tree } = (res.data ?? {}) as { yaml?: string };
    return {
      data: tree,
      untrusted: ['name'],
      ...(typeof yaml === 'string' ? { document: yaml } : {}),
    };
  },
};

export const listBudgetMonths: ToolDef = {
  name: 'ab_list_budget_months',
  route: { method: 'GET', path: '/budget/months' },
  tier: 'read',
  description: describe({
    what: 'Lists the months that exist in this budget, as YYYY-MM.',
    tier: 'read',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/budget/months');
    return { data: res.data };
  },
};

export const getBudgetMonth: ToolDef = {
  name: 'ab_get_budget_month',
  route: { method: 'GET', path: '/budget/month/:month' },
  tier: 'read',
  description: describe({
    what: 'Gets one budget month: per category, the amount budgeted, spent, the balance and any carryover, all in integer cents. A category with no budget entry returns budgeted: null, which means "not budgeted" and is DIFFERENT from budgeted: 0, which means the operator deliberately budgeted nothing.',
    tier: 'read',
    insteadOf:
      "Use this rather than summing ab_list_transactions — this is the app's own aggregation.",
  }),
  inputSchema: {
    type: 'object',
    properties: { month: monthField('The budget month to fetch.') },
    required: ['month'],
    additionalProperties: false,
  },
  schema: z
    .object({ month: z.string().regex(/^\d{4}-\d{2}$/, 'must be YYYY-MM') })
    .strip(),
  async run(args, ctx) {
    const { month } = args as { month: string };
    const res = await ctx.client.request(
      `/budget/month/${encodeURIComponent(month)}`,
    );
    // Returned verbatim. Nothing here defaults a null to 0 — see the module
    // comment; that coercion is the bug this whole family is written around.
    return { data: res.data, untrusted: ['name'] };
  },
};

export const getCategorySpend: ToolDef = {
  name: 'ab_get_category_spend',
  route: { method: 'GET', path: '/budget/category-spend' },
  tier: 'read',
  description: describe({
    what: 'Gets the total spent in one category over a date range, in integer cents, computed by the app.',
    tier: 'read',
    insteadOf:
      'Use this rather than listing transactions and adding them up — splits make the manual sum wrong.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      category_id: { type: 'string', description: 'The category id.' },
      start: dateField('Start of the range, inclusive.'),
      end: dateField('End of the range, inclusive.'),
    },
    required: ['category_id', 'start', 'end'],
    additionalProperties: false,
  },
  schema: z
    .object({
      category_id: z.string().min(1),
      start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .strip(),
  async run(args, ctx) {
    const a = args as { category_id: string; start: string; end: string };
    const res = await ctx.client.request('/budget/category-spend', {
      query: { category_id: a.category_id, start: a.start, end: a.end },
    });
    return { data: res.data };
  },
};

export const listBudgetGaps: ToolDef = {
  name: 'ab_list_budget_gaps',
  route: { method: 'GET', path: '/budget/gaps' },
  tier: 'read',
  description: describe({
    what: 'Lists categories that have spending in a month but NO budget entry for it — the "not budgeted, as distinct from budgeted zero" question, asked directly.',
    tier: 'read',
    insteadOf:
      'Use this when the operator asks what they forgot to budget for, rather than reading ab_get_budget_month and filtering.',
  }),
  inputSchema: {
    type: 'object',
    properties: { month: monthField('The budget month to examine.') },
    required: ['month'],
    additionalProperties: false,
  },
  schema: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).strip(),
  async run(args, ctx) {
    const { month } = args as { month: string };
    const res = await ctx.client.request('/budget/gaps', { query: { month } });
    return { data: res.data, untrusted: ['name'] };
  },
};

export const BUDGET_TOOLS = [
  listCategories,
  listCategoryGroups,
  getCategoryTree,
  listBudgetMonths,
  getBudgetMonth,
  getCategorySpend,
  listBudgetGaps,
];
