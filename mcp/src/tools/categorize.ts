/**
 * Categorising already-imported rows by their import id — pm/mcp.mdx §9.5,
 * over pm/apis.mdx §8.3a.
 *
 * A plan/apply pair, shaped exactly like ab_plan_file_import and
 * ab_apply_file_import: the plan is read-tier, so the operator can see every
 * row's outcome with the write switches off, and the apply needs the plan's
 * confirm_token. The server matches rows, resolves "Group > Category" paths
 * and decides what would change; these tools pass the list through and hand
 * back its answer.
 *
 * Neither tool creates a category. An unknown path comes back as
 * unknown_category, and the fix is the operator's: add the category in the
 * app, re-read ab_get_category_tree, and plan again.
 */
import { z } from 'zod';

import { describe } from './tool.js';
import type { ToolDef } from './tool.js';

export const planCategoriesByImport: ToolDef = {
  name: 'ab_plan_categories_by_import',
  route: { method: 'POST', path: '/transactions/categorize-by-import/plan' },
  tier: 'read',
  description: describe({
    what: 'Plans setting the category on rows ALREADY in the budget, found by account plus imported_id (the OFX FITID they were imported with): per row, whether it would change, is already set, is not found, or cannot be resolved, with counts and a confirm_token. Changes nothing.',
    tier: 'read',
    insteadOf:
      'Read ab_get_category_tree first and use only its "Group > Category" paths or ids. Show the operator the counts, then run ab_apply_categories_by_import with the token. For one row you already have the transaction id of, ab_update_transaction is simpler.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      assignments: {
        type: 'array',
        description: 'One entry per row to categorise.',
        items: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description:
                'The account id, or its exact name, from ab_list_accounts.',
            },
            imported_id: {
              type: 'string',
              description:
                'The imported_id the row carries — the FITID from the OFX file it was imported from.',
            },
            category: {
              type: 'string',
              description:
                'A "Group > Category" path from ab_get_category_tree, e.g. "Food > Groceries", or a category id. A bare category name works only if no other group has one of the same name.',
            },
          },
          required: ['account', 'imported_id', 'category'],
          additionalProperties: false,
        },
      },
      max_changes: {
        type: 'integer',
        description:
          'The most rows the apply may re-categorise. Defaults to the server ceiling (200); the plan reports within_max_changes.',
      },
    },
    required: ['assignments'],
    additionalProperties: false,
  },
  schema: z
    .object({
      assignments: z
        .array(
          z
            .object({
              account: z.string().min(1),
              imported_id: z.string().min(1),
              category: z.string().min(1),
            })
            .strip(),
        )
        .min(1),
      max_changes: z.number().int().positive().optional(),
    })
    .strip(),
  async run(args, ctx) {
    const res = await ctx.client.request(
      '/transactions/categorize-by-import/plan',
      { method: 'POST', body: args, noTimeout: true },
    );
    return { data: res.data, untrusted: ['account', 'category', 'path'] };
  },
};

export const applyCategoriesByImport: ToolDef = {
  name: 'ab_apply_categories_by_import',
  route: { method: 'POST', path: '/transactions/categorize-by-import/apply' },
  tier: 'write',
  description: describe({
    what: 'Sets the category on the rows an ab_plan_categories_by_import token was issued for, and changes nothing else on them, then syncs the budget.',
    tier: 'write',
    insteadOf:
      'Run ab_plan_categories_by_import first; this needs its confirm_token. The plan is recomputed here, and if a row was re-categorised since, this refuses rather than overwriting it. Each changed row comes back with the category it replaced.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      confirm: {
        type: 'string',
        description:
          'The confirm_token returned by ab_plan_categories_by_import.',
      },
      dry_run: {
        type: 'boolean',
        description:
          'Defaults to TRUE. Must be explicitly false to change anything.',
      },
    },
    required: ['confirm'],
    additionalProperties: false,
  },
  schema: z
    .object({ confirm: z.string().min(1), dry_run: z.boolean().optional() })
    .strip(),
  async run(args, ctx) {
    const a = args as { confirm: string; dry_run?: boolean };
    const res = await ctx.client.request(
      '/transactions/categorize-by-import/apply',
      {
        method: 'POST',
        body: { confirm_token: a.confirm, dry_run: a.dry_run ?? true },
        noTimeout: true,
      },
    );
    return { data: res.data, untrusted: ['account', 'category', 'path'] };
  },
};

export const CATEGORIZE_TOOLS = [
  planCategoriesByImport,
  applyCategoriesByImport,
];
