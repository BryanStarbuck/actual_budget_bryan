// GENERATED from packages/error-file — run scripts/sync-error-file.mjs
// Privacy — pm/error_err.mdx §11. The library enforces this; call sites are not trusted to (R12).
//
// Three defences, applied to every `data` value (and URL redaction also to messages):
//   1. a key that names a secret has its value replaced with [redacted];
//   2. a URL has the values of its sensitive query parameters replaced (names kept);
//   3. a key that names ledger data is dropped and replaced with [ledger-field refused].

import { capMiddle, safeString, stripControlChars } from './describe.ts';

/** Keys whose VALUES are secrets. */
export const SECRET_KEY =
  /pass(word)?|secret|token|auth|cookie|session|key|signature|credential|bearer/i;

/** Keys whose values are ledger data — refused outright, the repo is public and the budget is not. */
export const LEDGER_KEY =
  /amount|balance|payee|notes?|memo|account_?name|category_?name|description|imported_payee|statement/i;

export const REDACTED = '[redacted]';
export const LEDGER_REFUSED = '[ledger-field refused]';

/** Query parameters whose values are redacted inside any URL. */
const SENSITIVE_QUERY = new Set([
  'token',
  'code',
  'state',
  'key',
  'password',
  'secret',
  'signature',
  'sig',
]);

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function redactOneUrl(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hash = url.indexOf('#', q);
  const query = url.slice(q + 1, hash < 0 ? undefined : hash);
  const rest = hash < 0 ? '' : url.slice(hash);
  const redacted = query
    .split('&')
    .map(pair => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name);
      } catch {
        // a malformed escape is still a name; compare it raw
      }
      return eq >= 0 && SENSITIVE_QUERY.has(decoded.toLowerCase())
        ? `${name}=${REDACTED}`
        : pair;
    })
    .join('&');
  return `${url.slice(0, q)}?${redacted}${rest}`;
}

/** Redact sensitive query values in every URL found inside `text`. */
export function redactUrls(text: string): string {
  try {
    return text.includes('://')
      ? text.replace(URL_PATTERN, redactOneUrl)
      : text;
  } catch {
    return text;
  }
}

/** Per-value cap inside the data block; the whole block is capped again when formatted. */
const VALUE_CAP = 300;

export type ErrorDataValue = string | number | boolean | null | undefined;
export type ErrorData = Record<string, ErrorDataValue>;

/** Apply §11 to one key/value. Returns null when the pair should be omitted (undefined value). */
export function redactValue(key: string, value: unknown): string | null {
  if (LEDGER_KEY.test(key)) return LEDGER_REFUSED;
  if (value === undefined) return null;
  if (SECRET_KEY.test(key)) return REDACTED;
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'string') {
    return capMiddle(stripControlChars(redactUrls(value)), VALUE_CAP);
  }
  // Objects are not allowed in `data` (they are where ledger rows hide). Say so, never print it.
  return `[${typeof value} not allowed]`;
}

/**
 * Redact a whole data block. Accepts `unknown` because the ingest route re-applies this to data
 * that arrived from a browser (§8.2 step 6) and trusts none of it.
 */
export function redactData(data: unknown): Record<string, string> | null {
  if (data === null || data === undefined || typeof data !== 'object') {
    return null;
  }
  try {
    const out: Record<string, string> = {};
    let count = 0;
    for (const key of Object.keys(data)) {
      if (count >= 40) break;
      let raw: unknown;
      try {
        raw = Reflect.get(data, key);
      } catch {
        raw = '[unreadable]';
      }
      const cleanKey = stripControlChars(key)
        .replace(/[\s={}]/g, '_')
        .slice(0, 60);
      const value = redactValue(cleanKey, raw);
      if (value === null) continue;
      out[cleanKey] = value;
      count++;
    }
    return count ? out : null;
  } catch {
    return { data: safeString('[unreadable data]') };
  }
}
