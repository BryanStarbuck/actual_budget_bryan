/**
 * P3 — the confirm token — pm/apis.mdx §7.3.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  canonical,
  fingerprintOf,
  issueConfirm,
  peekConfirm,
  redeemConfirm,
  resetConfirmsForTests,
} from './confirm.js';

afterEach(() => {
  resetConfirmsForTests();
});

describe('fingerprints', () => {
  it('do not depend on key order', () => {
    expect(fingerprintOf({ a: 1, b: [{ d: 2, c: 3 }] })).toBe(
      fingerprintOf({ b: [{ c: 3, d: 2 }], a: 1 }),
    );
    expect(canonical({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('change when the change set changes', () => {
    expect(fingerprintOf({ added: 117 })).not.toBe(fingerprintOf({ added: 118 }));
  });
});

describe('tokens', () => {
  it('are opaque, expire in ten minutes, and carry their payload', () => {
    const issued = issueConfirm('ingest.file', 'sha256:abcd', { path: '/x.ofx' });
    expect(issued.confirm_token).toMatch(/^cf_/);
    expect(Date.parse(issued.expires_at) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(peekConfirm(issued.confirm_token, 'ingest.file').payload).toEqual({ path: '/x.ofx' });
  });

  it('refuse a missing token with a hint to dry-run first', () => {
    expect(() => peekConfirm(undefined, 'x')).toThrow(/confirm_token is required/);
  });

  it('refuse an invented token', () => {
    expect(() => peekConfirm('cf_made_up', 'x')).toThrow(/unknown, expired, or already used/);
  });

  it('refuse a token from a different kind of plan', () => {
    const { confirm_token } = issueConfirm('account.create', 'sha256:1');
    expect(() => peekConfirm(confirm_token, 'ingest.file')).toThrow(/belongs to a account.create plan/);
  });

  it('refuse when the plan moved, and report the new plan', () => {
    const { confirm_token } = issueConfirm('transactions.import', 'sha256:old');
    expect(() =>
      redeemConfirm(confirm_token, 'transactions.import', 'sha256:new', { added: 3 }),
    ).toThrow(/changed since.*"added":3/s);
    // …and it is gone: no second try against the stale plan.
    expect(() => peekConfirm(confirm_token, 'transactions.import')).toThrow(/unknown/);
  });

  it('work exactly once', () => {
    const { confirm_token, fingerprint } = issueConfirm('transactions.import', 'sha256:same');
    redeemConfirm(confirm_token, 'transactions.import', fingerprint, {});
    expect(() =>
      redeemConfirm(confirm_token, 'transactions.import', fingerprint, {}),
    ).toThrow(/unknown, expired, or already used/);
  });
});
