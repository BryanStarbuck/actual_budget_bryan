/**
 * The statements pipeline — pm/mcp.mdx §11, pm/cli.mdx §10.
 *
 * Seven read tools and one write. The three contracts a model must not be
 * allowed to break:
 *
 *   1. It never judges a duplicate. There is no ab_mark_duplicate, no
 *      ab_merge_rows, and no argument anywhere that says "treat these as the
 *      same". A conflict is surfaced with both files named and BOTH row sets
 *      shown, and the description says to ask rather than choose.
 *
 *   2. It never sees raw statement text. Tools return parsed rows; a
 *      statement's raw text is the operator's most sensitive document (§7.4).
 *
 *   3. It cannot un-delete. There is no reimport_deleted argument, because
 *      resurrecting records the operator deliberately deleted is not
 *      something an agent should be able to do on a persuasive sentence.
 */
import { z } from 'zod';

import { clampLimit } from '../gates.js';

import { describe, monthField } from './tool.js';
import type { ToolDef } from './tool.js';

const statementFilters = {
  entity: {
    type: 'string',
    description:
      'Restrict to one entity (the top-level folder in the statements tree).',
  },
  bank: { type: 'string', description: 'Restrict to one bank.' },
  account: { type: 'string', description: 'Restrict to one account folder.' },
} as const;

const filterSchema = {
  entity: z.string().optional(),
  bank: z.string().optional(),
  account: z.string().optional(),
};

export const scanStatements: ToolDef = {
  name: 'ab_scan_statements',
  route: { method: 'POST', path: '/statements/scan' },
  tier: 'read',
  description: describe({
    what: 'Walks the configured bank-statement tree and returns entity/bank/account/period groups with counts, flagging months with no statement, duplicate scans, and PDFs with no usable extraction. Changes nothing on disk.',
    tier: 'read',
    insteadOf:
      'For just the gaps, ab_list_missing_statements is narrower and easier to read.',
  }),
  inputSchema: {
    type: 'object',
    properties: { ...statementFilters },
    additionalProperties: false,
  },
  schema: z.object(filterSchema).strip(),
  async run(args, ctx) {
    const res = await ctx.client.request('/statements/scan', {
      method: 'POST',
      body: args,
      noTimeout: true,
    });
    return { data: res.data, untrusted: ['path', 'entity', 'bank'] };
  },
};

export const listMissingStatements: ToolDef = {
  name: 'ab_list_missing_statements',
  route: { method: 'POST', path: '/statements/missing' },
  tier: 'read',
  description: describe({
    what: 'Lists the account-months that have no statement file, as {entity, bank, account, period} records.',
    tier: 'read',
  }),
  inputSchema: {
    type: 'object',
    properties: { ...statementFilters },
    additionalProperties: false,
  },
  schema: z.object(filterSchema).strip(),
  async run(args, ctx) {
    const res = await ctx.client.request('/statements/missing', {
      method: 'POST',
      body: args,
      noTimeout: true,
    });
    return { data: res.data };
  },
};

export const extractStatements: ToolDef = {
  name: 'ab_extract_statements',
  route: { method: 'POST', path: '/statements/extract' },
  tier: 'read',
  description: describe({
    what: 'Turns statement PDFs and their text sidecars into canonical rows in the staging directory. This writes only into the staging area under the statements root and NEVER touches the budget, so it cannot change any account.',
    tier: 'read',
    insteadOf:
      'Run this before ab_plan_statement_import. It can take minutes over a large archive; do not retry it because it is slow.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      ...statementFilters,
      force: {
        type: 'boolean',
        description:
          'Re-extract statements that already have rows. Defaults to false, which makes a second run cheap.',
      },
    },
    additionalProperties: false,
  },
  schema: z.object({ ...filterSchema, force: z.boolean().optional() }).strip(),
  async run(args, ctx) {
    const res = await ctx.client.request('/statements/extract', {
      method: 'POST',
      body: args,
      noTimeout: true,
    });
    return { data: res.data };
  },
};

export const listStatementDuplicates: ToolDef = {
  name: 'ab_list_statement_duplicates',
  route: { method: 'POST', path: '/statements/duplicates' },
  tier: 'read',
  description: describe({
    what: 'Lists every account-month covered by more than one statement, the verdict for each file (identical, superseded or conflict), and the rule that decided it.',
    tier: 'read',
    insteadOf:
      'When a group is a conflict, show the operator both files and ASK which is correct — do not choose. Choosing silently is choosing which of their transactions exist.',
  }),
  inputSchema: {
    type: 'object',
    properties: { ...statementFilters },
    additionalProperties: false,
  },
  schema: z.object(filterSchema).strip(),
  async run(args, ctx) {
    const res = await ctx.client.request('/statements/duplicates', {
      method: 'POST',
      body: args,
      noTimeout: true,
    });
    return { data: res.data, untrusted: ['path'] };
  },
};

export const getStatementRows: ToolDef = {
  name: 'ab_get_statement_rows',
  route: { method: 'POST', path: '/statements/rows' },
  tier: 'read',
  description: describe({
    what: 'Returns the de-duplicated rows extracted for one account-month: date, amount in integer cents, payee, the raw bank description, and the provenance of each row. Parsed rows only — never the raw text of the statement.',
    tier: 'read',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      entity: statementFilters.entity,
      bank: statementFilters.bank,
      account: statementFilters.account,
      period: monthField('The account-month to return rows for.'),
      limit: {
        type: 'integer',
        description: 'Maximum rows. Clamped and reported.',
      },
    },
    required: ['entity', 'bank', 'account', 'period'],
    additionalProperties: false,
  },
  schema: z
    .object({
      entity: z.string().min(1),
      bank: z.string().min(1),
      account: z.string().min(1),
      period: z.string().regex(/^\d{4}-\d{2}$/),
      limit: z.number().int().positive().optional(),
    })
    .strip(),
  async run(args, ctx) {
    const a = args as Record<string, unknown> & { limit?: number };
    const { limit, clamped } = clampLimit(a.limit, ctx.config);
    const res = await ctx.client.request('/statements/rows', {
      method: 'POST',
      body: { ...a, limit },
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    return {
      data: res.data,
      untrusted: ['payee', 'imported_payee', 'notes', 'source_file'],
      truncated: clamped || rows.length >= limit,
      limitApplied: limit,
    };
  },
};

export const describeStatementMap: ToolDef = {
  name: 'ab_describe_statement_map',
  route: { method: 'POST', path: '/statements/map' },
  tier: 'read',
  description: describe({
    what: 'Describes the map file that connects folders in the statements tree to budget accounts, and reports which mappings currently resolve to a real account.',
    tier: 'read',
    insteadOf:
      'Check this before planning an import — an unmapped folder imports nothing and the plan will simply not mention it.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      map_path: {
        type: 'string',
        description: 'Path to the map file. Defaults to the configured one.',
      },
    },
    additionalProperties: false,
  },
  schema: z.object({ map_path: z.string().optional() }).strip(),
  async run(args, ctx) {
    const res = await ctx.client.request('/statements/map', {
      method: 'POST',
      body: args,
    });
    return { data: res.data, untrusted: ['path'] };
  },
};

export const planStatementImport: ToolDef = {
  name: 'ab_plan_statement_import',
  route: { method: 'POST', path: '/statements/plan' },
  tier: 'read',
  description: describe({
    what: 'Computes exactly what an import would do, per account: rows extracted, rows after de-duplication, how many the budget already has, how many the app would fuzzy-match, and how many are new. Returns a confirm_token. Changes nothing.',
    tier: 'read',
    insteadOf:
      'ALWAYS run this before ab_apply_statement_import and show the operator the result. The token it returns is required to apply, and it cannot be invented.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      ...statementFilters,
      map_path: {
        type: 'string',
        description: 'Path to the map file. Defaults to the configured one.',
      },
    },
    additionalProperties: false,
  },
  schema: z
    .object({ ...filterSchema, map_path: z.string().optional() })
    .strip(),
  async run(args, ctx) {
    // This is the app's own importer run in preview mode, not our prediction
    // of it (cli.mdx §10.8) — so the counts below ARE the authority's verdict.
    const res = await ctx.client.request('/statements/plan', {
      method: 'POST',
      body: args,
      noTimeout: true,
    });
    return { data: res.data, untrusted: ['path', 'payee'] };
  },
};

export const applyStatementImport: ToolDef = {
  name: 'ab_apply_statement_import',
  route: { method: 'POST', path: '/statements/apply' },
  tier: 'write',
  description: describe({
    what: "Runs a statement import plan through the budget application's own importer, adding the new transactions.",
    tier: 'write',
    insteadOf:
      'Run ab_plan_statement_import first and show the operator the plan; this tool requires the confirm_token that call returned. The plan is recomputed here, and if it has changed since, this refuses rather than importing something the operator did not see.',
  }),
  inputSchema: {
    type: 'object',
    properties: {
      ...statementFilters,
      map_path: {
        type: 'string',
        description: 'Path to the map file. Defaults to the configured one.',
      },
      confirm: {
        type: 'string',
        description:
          'The confirm_token returned by ab_plan_statement_import for this exact plan.',
      },
      dry_run: {
        type: 'boolean',
        description:
          'Defaults to TRUE. Must be explicitly false to change anything.',
      },
      max_changes: {
        type: 'integer',
        description:
          'Refuse if the import would add more rows than this. The refusal reports the real number.',
      },
    },
    additionalProperties: false,
  },
  schema: z
    .object({
      ...filterSchema,
      map_path: z.string().optional(),
      confirm: z.string().optional(),
      dry_run: z.boolean().optional(),
      max_changes: z.number().int().positive().optional(),
    })
    .strip(),
  async run(args, ctx) {
    const a = args as Record<string, unknown> & {
      confirm?: string;
      dry_run?: boolean;
      max_changes?: number;
    };
    const res = await ctx.client.request('/statements/apply', {
      method: 'POST',
      body: {
        ...a,
        // dry_run defaults TRUE on every write tool (§9.6): the safe value is
        // the one you get by not thinking about it.
        dry_run: a.dry_run ?? true,
        max_changes: a.max_changes ?? ctx.config.maxChanges,
      },
      noTimeout: true,
    });
    return { data: res.data };
  },
};

export const STATEMENT_TOOLS = [
  scanStatements,
  listMissingStatements,
  extractStatements,
  listStatementDuplicates,
  getStatementRows,
  describeStatementMap,
  planStatementImport,
  applyStatementImport,
];
