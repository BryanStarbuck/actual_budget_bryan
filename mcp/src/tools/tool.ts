/**
 * The tool shape — pm/mcp.mdx §9.
 *
 * A tool validates its arguments, makes ONE machine-plane call, and returns
 * the app's answer. It does not sum, filter, sort, round, join, cache a
 * computed value, or decide anything a reasonable person could disagree with
 * (§9.4). If a tool seems to need computation, the computation becomes a
 * machine-plane route first and the tool calls it.
 */
import type { z } from 'zod';

import type { MachinePlaneClient } from '../client.js';
import type { Config } from '../config.js';

export type Tier = 'read' | 'write';

export type ToolContext = {
  client: MachinePlaneClient;
  config: Config;
};

export type ToolResult = {
  data: unknown;
  /** Field names carrying bank/statement/operator text (§7.5). */
  untrusted?: string[];
  truncated?: boolean;
  limitApplied?: number;
  budgetId?: string;
  budgetName?: string;
};

export type ToolDef = {
  name: string;
  /** Hand-authored JSON Schema — the model reads these words verbatim (§8.2). */
  inputSchema: Record<string, unknown>;
  description: string;
  tier: Tier;
  /** Runtime parse, gate 5. Unknown keys stripped, limits clamped (§7.1). */
  schema: z.ZodType;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
};

/**
 * The fourth mandatory description clause (§9.2), written out in full on every
 * tool — because a model that has read a description and still does not know
 * whose tool it is will route on the noun instead.
 */
export const WHICH_SERVER =
  'This server is the operator\'s OWN Actual Budget install on this computer. ' +
  'It is not company bookkeeping (`quickbooks`) and not a film project (`act3`).';

/** The second clause, for the 28 tools that only read. */
export const READS_ONLY = 'Reads only.';

/**
 * The second clause, for the 5 that do not.
 *
 * "Changes are synced to their other devices" is the real affordance and the
 * reason this sentence is not softened: a bad write is on the operator's phone
 * before anyone reviews it.
 */
export const WRITES =
  'WRITES to the operator\'s real budget. Changes are synced to their other devices.';

/**
 * Assemble a description from its mandatory clauses.
 *
 * Going through one function is what lets a test assert all four are present
 * on all 33 tools, rather than hoping nobody pasted a description by hand.
 */
export function describe(opts: {
  /** Clause 1 — what it does, in domain language, one sentence. */
  what: string;
  /** Clause 2 — the cost. */
  tier: Tier;
  /** Clause 3 — which sibling to use instead, when there is one. */
  insteadOf?: string;
}): string {
  const parts = [opts.what, opts.tier === 'read' ? READS_ONLY : WRITES];
  if (opts.insteadOf !== undefined) {
    parts.push(opts.insteadOf);
  }
  parts.push(WHICH_SERVER);
  return parts.join(' ');
}

/**
 * A cents-valued JSON Schema field.
 *
 * Every amount field in every schema is `"type": "integer"` with "cents" in
 * its description and an example, because a model asked for "about $123" will
 * otherwise happily produce 123.5 (§10.1).
 */
export function centsField(description: string): Record<string, unknown> {
  return {
    type: 'integer',
    description: `${description} In integer CENTS, never dollars — 50000 is $500.00, and -12350 is -$123.50.`,
  };
}

export function dateField(description: string): Record<string, unknown> {
  return {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: `${description} As YYYY-MM-DD.`,
  };
}

export function monthField(description: string): Record<string, unknown> {
  return {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}$',
    description: `${description} As YYYY-MM.`,
  };
}
