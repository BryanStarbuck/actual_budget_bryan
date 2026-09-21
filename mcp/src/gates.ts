/**
 * The gates — pm/mcp.mdx §7.1.
 *
 * Every tools/call passes all of these. Failing any one produces a typed
 * denial in the audit log rather than an exception.
 *
 * Gates 1 and 2 (transport, key) are satisfied at startup: this process binds
 * no port, and it refuses to start without a readable 0600 key. What remains
 * per-call is here. Gate 6 — the machine plane's own loopback + origin + key
 * + mode + input ladder — is on the server and does not trust any of this, so
 * a bug here is not sufficient to cause harm.
 */
import type { Config } from './config.js';
import { fail } from './envelope.js';
import type { ToolDef } from './tools/tool.js';

/**
 * Gate 4 — mode.
 *
 * A write tool the mode gate rejects is still LISTED in tools/list, with its
 * description saying it is disabled and how to enable it. A tool that vanishes
 * teaches the model nothing, and a model that cannot see the tool will look
 * for another way to do the same thing (§7.1).
 */
export function checkMode(tool: ToolDef, config: Config): void {
  if (tool.tier !== 'write') {
    return;
  }

  if (config.target === 'remote') {
    throw fail(
      'write_disabled',
      'This server is pointed at a remote install, which is read-only.',
      'a remote target never permits writes, with or without the write switches',
    );
  }

  if (!config.allowWrite) {
    // Both switches named, because the operator has to set both and being
    // told about one is being sent back for a second round trip (§9.7).
    throw fail(
      'write_disabled',
      'The write tier is off.',
      'Set ACTUAL_MACHINE_ALLOW_WRITE=1 on the sync server and ABMCP_ALLOW_WRITE=1 here, then retry.',
    );
  }
}

/**
 * Gate 5 — input.
 *
 * Unknown keys are stripped. Limits are CLAMPED rather than rejected: a model
 * asking for 10,000 rows gets 1,000 and a truncated flag, not an error it
 * will retry differently — and differently usually means smaller, then
 * smaller again, burning turns to arrive where clamping starts.
 */
export function checkInput<T>(tool: ToolDef, args: unknown): T {
  const parsed = tool.schema.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') ?? '';
    const detail = issue?.message ?? 'invalid arguments';
    throw fail(
      'invalid_input',
      where === '' ? detail : `${where}: ${detail}`,
      "check the tool's input schema and retry with corrected arguments",
    );
  }
  return parsed.data as T;
}

/**
 * Layer 6 of §3.4 — refuse-with-redirect on a foreign-shaped argument.
 *
 * This catches the model that has ALREADY routed wrong, and teaches it at the
 * moment it crosses rather than letting it read a confident answer about the
 * wrong books. The redirect names a server, and it is the only place this
 * server emits text telling a model to call something else (§7.5).
 */
const FOREIGN_SHAPES: Array<{
  test: RegExp;
  looksLike: string;
  server: string;
  suggestion: string;
}> = [
  {
    // QuickBooks realm ids are long numeric strings.
    test: /^\d{15,}$/,
    looksLike: 'a QuickBooks realm or entity id',
    server: 'quickbooks',
    suggestion: 'search_accounts',
  },
  {
    test: /^(INV|BILL)-?\d+$/i,
    looksLike: 'an invoice or bill number',
    server: 'quickbooks',
    suggestion: 'search_invoices',
  },
  {
    test: /^(proj|shot|scene|take)[-_]/i,
    looksLike: 'an ACT3 project identifier',
    server: 'act3',
    suggestion: 'list_projects',
  },
];

export function checkNotForeign(args: unknown): void {
  if (args === null || typeof args !== 'object') {
    return;
  }

  for (const value of Object.values(args as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      continue;
    }
    for (const shape of FOREIGN_SHAPES) {
      if (shape.test.test(value)) {
        throw fail(
          'wrong_server',
          `This looks like ${shape.looksLike}. This server only knows the Actual Budget install on this computer.`,
          `Use the \`${shape.server}\` server's \`${shape.suggestion}\`.`,
        );
      }
    }
  }
}

/**
 * Clamp a requested row limit, reporting when it bound (§15).
 *
 * A silent cap is how a model concludes an account has exactly 1,000
 * transactions and tells the operator so.
 */
export function clampLimit(
  requested: number | undefined,
  config: Config,
): { limit: number; clamped: boolean } {
  if (requested === undefined) {
    return { limit: config.maxRows, clamped: false };
  }
  if (requested > config.maxRows) {
    return { limit: config.maxRows, clamped: true };
  }
  return { limit: requested, clamped: false };
}
