/**
 * The response contract — pm/mcp.mdx §12.
 *
 * One shape, every time. The model never has to guess whether it is parsing.
 */

/**
 * The closed vocabulary — twelve codes (§12.3).
 *
 * The first nine are the machine plane's (cli.mdx §5.3) and arrive on the
 * wire. The last three are minted HERE and never appear in an HTTP response:
 * they name conditions this server detects before or instead of a call. The
 * relationship is one-way and total — every machine-plane code is also an MCP
 * code — so a server error passes through unchanged, and a test asserts this
 * list is a strict superset of the plane's.
 */
export const ERROR_CODES = [
  // From the machine plane.
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'conflict',
  'write_disabled',
  'not_ready',
  'upstream_error',
  'internal',
  // Minted here only.
  'confirm_required',
  'too_many_changes',
  'wrong_server',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The three this server mints. Kept explicit so the parity test can assert it. */
export const MCP_ONLY_CODES: readonly ErrorCode[] = [
  'confirm_required',
  'too_many_changes',
  'wrong_server',
];

export type Meta = {
  budgetId?: string;
  budgetName?: string;
  target: 'local' | 'remote';
  serverVersion?: string;
  asOf: string;
  tookMs: number;
  truncated: boolean;
  limitApplied?: number;
  /** Field names whose contents came from a bank, a statement or the operator (§7.5). */
  untrusted?: string[];
};

export type SuccessEnvelope = {
  ok: true;
  tool: string;
  data: unknown;
  meta: Meta;
};

export type FailureEnvelope = {
  ok: false;
  tool: string;
  error: { code: ErrorCode; message: string; hint?: string };
};

export type Envelope = SuccessEnvelope | FailureEnvelope;

/**
 * A tool failure.
 *
 * Thrown by handlers and turned into `isError: true` content by the host. It
 * is NEVER a JSON-RPC protocol error: losing one call must not kill a loop,
 * and `-32601`/`-32603` are reserved for genuine transport faults (§12.2).
 */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.hint = hint;
  }
}

/** `hint` always names a remediation — a code the model can branch on plus a way out. */
export function fail(
  code: ErrorCode,
  message: string,
  hint?: string,
): ToolError {
  return new ToolError(code, message, hint);
}
