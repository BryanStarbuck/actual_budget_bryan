/**
 * The response envelope — pm/cli.mdx §5.3.
 *
 * Every machine-plane response, success or failure, is one JSON object of the
 * same shape. The CLI and the MCP are both written against it, so a route that
 * answers in a different shape is a route that breaks two callers at once.
 */
import type { Response } from 'express';

/**
 * The closed vocabulary. Nine codes; a tenth is a spec change, not a commit.
 *
 * The MCP's vocabulary (mcp.mdx §12.3) is a strict SUPERSET of this one: it
 * adds confirm_required, too_many_changes and wrong_server, all of which it
 * mints itself and none of which may ever appear on the wire.
 */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'conflict',
  'write_disabled',
  'not_ready',
  'upstream_error',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_input: 400,
  conflict: 409,
  write_disabled: 403,
  not_ready: 503,
  upstream_error: 502,
  internal: 500,
};

export type Meta = {
  target: 'local';
  serverVersion: string;
  /** The server's timestamp for the answer. A balance without a date is a lie tomorrow. */
  asOf: string;
  tookMs: number;
  budgetId?: string;
  budgetName?: string;
  truncated?: boolean;
  limitApplied?: number;
};

export class MachineError extends Error {
  readonly code: ErrorCode;
  /** Always a remediation the caller can act on. */
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'MachineError';
    this.code = code;
    this.hint = hint;
  }
}

export function sendOk(
  res: Response,
  data: unknown,
  meta: Omit<Meta, 'target' | 'asOf'> & Partial<Pick<Meta, 'asOf'>>,
): void {
  res.status(200).json({
    ok: true,
    data,
    meta: {
      target: 'local',
      asOf: meta.asOf ?? new Date().toISOString(),
      ...meta,
    },
  });
}

export function sendError(res: Response, err: MachineError): void {
  res.status(HTTP_STATUS[err.code]).json({
    ok: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
    },
  });
}

/**
 * Turn anything thrown inside a handler into the envelope.
 *
 * An unexpected throw becomes `internal` with a generic message: the caller
 * gets a code it can branch on, and the stack stays in the server's own log
 * rather than travelling to a model's context window.
 */
export function toMachineError(err: unknown): MachineError {
  if (err instanceof MachineError) {
    return err;
  }
  return new MachineError(
    'internal',
    'The request failed inside the app.',
    'read ~/T/_actual_budget/server.log',
  );
}
