/**
 * The catalogue — pm/mcp.mdx §9.3.
 *
 * ONE array. tools/list and dispatch both read it, and there is no second
 * list to update. A tool present in the catalogue but missing from dispatch
 * is a tool the model will call and get -32601 for, and that failure looks
 * like a broken server rather than a missing case.
 */
import { ACCOUNT_TOOLS, TRANSACTION_TOOLS } from './accounts.js';
import { BUDGET_TOOLS } from './budget.js';
import { ORIENTATION_TOOLS } from './orientation.js';
import { QUERY_TOOLS, REFERENCE_TOOLS } from './reference.js';
import { STATEMENT_TOOLS } from './statements.js';
import type { ToolDef } from './tool.js';
import { WRITE_TOOLS } from './writes.js';

export const TOOLS: readonly ToolDef[] = Object.freeze([
  ...ORIENTATION_TOOLS, // 3 read
  ...ACCOUNT_TOOLS, // 3 read
  ...TRANSACTION_TOOLS, // 3 read
  ...BUDGET_TOOLS, // 6 read
  ...REFERENCE_TOOLS, // 4 read
  ...QUERY_TOOLS, // 2 read
  ...STATEMENT_TOOLS, // 10 read + 3 write (ab_apply_accounts, ab_apply_file_import, ab_apply_statement_import)
  ...WRITE_TOOLS, // 4 write
]);

const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));

export function findTool(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/** Counts, computed rather than asserted, so the spec's numbers stay checkable. */
export const TOOL_COUNTS = {
  total: TOOLS.length,
  read: TOOLS.filter(tool => tool.tier === 'read').length,
  write: TOOLS.filter(tool => tool.tier === 'write').length,
} as const;
