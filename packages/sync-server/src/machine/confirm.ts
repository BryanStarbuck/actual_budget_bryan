/**
 * The confirm token — pm/apis.mdx §7.3.
 *
 * A write route's dry run returns a token; the real call must echo it. The
 * token proves exactly one thing: the caller has READ the plan this process
 * just produced. A model cannot invent it, and no amount of confident
 * guessing substitutes.
 *
 * Three properties, each load-bearing:
 *
 *   - In-process only. Not persisted, not derived from the key, gone on
 *     restart. It is not a credential and must never become one.
 *   - Bound to a FINGERPRINT of the change set. The apply recomputes the plan
 *     and compares; if the world moved underneath it — a sync landed, a row
 *     was categorised in the browser — the token is refused with `conflict`
 *     and the new counts, so nobody applies an hour-old plan.
 *   - Single use and ten minutes. A token that worked twice is a token that
 *     imported twice.
 *
 * The fingerprint is over the change set the caller was SHOWN, never over
 * ids the engine mints during a preview (those differ per run), so two
 * previews of the same state agree.
 */
import { createHash, randomBytes } from 'node:crypto';

import { MachineError } from './envelope.js';

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

export type Issued = {
  confirm_token: string;
  expires_at: string;
  fingerprint: string;
};

type Entry = {
  kind: string;
  fingerprint: string;
  payload: unknown;
  expiresAt: number;
};

const tokens = new Map<string, Entry>();

/** Canonical JSON: keys sorted at every level, so the same set hashes the same. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      );
    }
    return v;
  });
}

export function fingerprintOf(changeSet: unknown): string {
  return `sha256:${createHash('sha256').update(canonical(changeSet)).digest('hex').slice(0, 16)}`;
}

function sweep(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) {
      tokens.delete(token);
    }
  }
}

/**
 * Issue a token for a plan. `payload` is whatever the apply needs to
 * recompute the plan (file path, options) — it travels with the token, so
 * the apply cannot be pointed at a different file than the plan.
 */
export function issueConfirm(
  kind: string,
  fingerprint: string,
  payload: unknown = null,
): Issued {
  const now = Date.now();
  sweep(now);
  const token = `cf_${randomBytes(16).toString('base64url')}`;
  const expiresAt = now + CONFIRM_TTL_MS;
  tokens.set(token, { kind, fingerprint, payload, expiresAt });
  return {
    confirm_token: token,
    expires_at: new Date(expiresAt).toISOString(),
    fingerprint,
  };
}

/**
 * Look a token up without consuming it, so the apply can recompute the plan
 * from its payload first. Throws `conflict` for missing, expired, or the
 * wrong kind of plan.
 */
export function peekConfirm(token: string | undefined, kind: string): Entry {
  if (!token) {
    throw new MachineError(
      'invalid_input',
      'confirm_token is required to change anything.',
      'run the same call with dry_run: true, read the plan, and pass the confirm_token it returns',
    );
  }
  sweep(Date.now());
  const entry = tokens.get(token);
  if (!entry) {
    throw new MachineError(
      'conflict',
      'That confirm_token is unknown, expired, or already used.',
      'tokens last ten minutes and work once — re-run the dry run for a fresh one',
    );
  }
  if (entry.kind !== kind) {
    throw new MachineError(
      'conflict',
      `That confirm_token belongs to a ${entry.kind} plan, not a ${kind} plan.`,
      'use the token from the matching dry run',
    );
  }
  return entry;
}

/**
 * Consume a token, requiring the recomputed fingerprint to match the one it
 * was issued for. The `current` change set is reported on refusal so the
 * caller learns what moved rather than just that something did.
 */
export function redeemConfirm(
  token: string,
  kind: string,
  recomputed: string,
  current: unknown,
): void {
  const entry = peekConfirm(token, kind);
  if (entry.fingerprint !== recomputed) {
    tokens.delete(token);
    throw new MachineError(
      'conflict',
      `The plan changed since that token was issued (was ${entry.fingerprint}, now ${recomputed}). Nothing was written. Current plan: ${JSON.stringify(current)}`,
      're-run the dry run, read the new plan, and confirm that one',
    );
  }
  tokens.delete(token);
}

/** Test seam. */
export function resetConfirmsForTests(): void {
  tokens.clear();
}
