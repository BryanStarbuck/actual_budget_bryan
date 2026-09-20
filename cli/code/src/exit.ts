/**
 * Exit codes — pm/cli.mdx §14.
 *
 * Scripts branch on these, so they are part of the contract and not free to
 * drift. Two of them are worth the care:
 *
 *   3 — NOT FOUND is a fact, not a failure. "There is no statement for
 *       2023-04" is a true answer to a real question, and giving it its own
 *       code is what lets `abx statements missing || echo all-present` be
 *       written.
 *
 *   4 — CONFLICT is a question for a human, not a failure of the program.
 *
 * And the pair that exists only so a first-run failure is diagnosable:
 *
 *   2 — a LOCAL refusal: we never sent anything.
 *   6 — a 401 from a server that IS reachable: we sent, and it said no.
 *
 * Collapsing those two is how an operator ends up rotating a perfectly good
 * key because a missing one looked identical.
 */
export const Exit = {
  ok: 0,
  failed: 1,
  usage: 2,
  notFound: 3,
  conflict: 4,
  unreachable: 5,
  unauthorized: 6,
  /** EX_UNAVAILABLE — the shim could not build the binary (§14). */
  notBuilt: 69,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];

/**
 * An error carrying the exit code it should produce and, wherever possible,
 * the command that fixes it.
 *
 * `hint` is not decoration. Every failure this CLI can produce is a failure
 * somebody has to get out of, and the CLI is the program that knows which
 * file, port or flag was involved.
 */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint?: string;
  readonly detail?: string;

  constructor(
    code: ExitCode,
    message: string,
    opts: { hint?: string; detail?: string } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (opts.hint !== undefined) {
      this.hint = opts.hint;
    }
    if (opts.detail !== undefined) {
      this.detail = opts.detail;
    }
  }
}

export function usageError(message: string, hint?: string): CliError {
  return new CliError(Exit.usage, message, hint === undefined ? {} : { hint });
}
