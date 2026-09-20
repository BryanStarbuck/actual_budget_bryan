/**
 * The argument contract — pm/cli.mdx §7.
 *
 * Positional first, flags anywhere. The one design decision worth explaining
 * is §7.3: there is NO hand-maintained `takesValue` set.
 *
 * The obvious implementation keeps a list of value-taking flags and a rule
 * saying "add to it in the same edit". That rule fails silently, and it fails
 * in exactly the way that is hardest to notice: a flag missing from the list
 * parses as a BOOLEAN, so `--start 2026-01-01` becomes `--start` true plus a
 * stray positional, and the verb either drops the date or takes it as its
 * subject. Nothing errors. The spec's own draft list was already wrong about
 * three flags, which is the proof that discipline is not the fix.
 *
 * So arity is declared next to the flag, on the verb that owns it, and the
 * parser derives everything from that declaration. A flag that takes a value
 * cannot be registered without saying so, because the declaration is the only
 * place the flag exists at all.
 */
import { CliError, Exit, usageError } from './exit.js';

/** `boolean` takes no value; anything else names the value in help text. */
export type FlagArity =
  | 'boolean'
  | 'string'
  | 'number'
  | 'path'
  | 'date'
  | 'cents';

export type FlagSpec = {
  arity: FlagArity;
  help: string;
  /** Repeatable flags collect into an array rather than last-wins. */
  repeatable?: boolean;
};

export type FlagSpecs = Record<string, FlagSpec>;

/**
 * The universal flags every verb accepts (§7.1).
 *
 * They live here rather than being copied onto each verb so that adding one
 * reaches every verb at once, and so `abx help <verb>` can show the two sets
 * separately — an operator wants to know which flags are this verb's.
 */
export const UNIVERSAL_FLAGS: FlagSpecs = {
  format: {
    arity: 'string',
    help: 'json | table | csv — what stdout carries (default: json)',
  },
  write: {
    arity: 'boolean',
    help: 'actually write; without it every write verb is a dry run',
  },
  yes: { arity: 'boolean', help: 'confirm a write larger than --max-changes' },
  'max-changes': {
    arity: 'number',
    help: 'the write ceiling for this run (default: 200)',
  },
  api: {
    arity: 'string',
    help: 'talk to a different install — loopback or https: only',
  },
  timeout: {
    arity: 'number',
    help: 'per-call timeout in ms (ignored by the long verbs)',
  },
  'no-bringup': {
    arity: 'boolean',
    help: 'never start the app; fail with exit 5 if it is down',
  },
  quiet: {
    arity: 'boolean',
    help: 'no spinner, no progress, no informational stderr',
  },
  verbose: {
    arity: 'boolean',
    help: 'informational stderr, plus target and key fingerprint',
  },
  'json-errors': {
    arity: 'boolean',
    help: 'errors on stderr as one JSON object per line',
  },
  help: { arity: 'boolean', help: 'usage for this verb' },
  h: { arity: 'boolean', help: 'usage for this verb' },
};

export type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | number | boolean | string[]>;
};

function isFlagToken(token: string): boolean {
  return token.startsWith('--') || /^-[a-zA-Z]$/.test(token);
}

function flagName(token: string): string {
  return token.startsWith('--') ? token.slice(2) : token.slice(1);
}

/**
 * Levenshtein distance, bounded — only ever used to say "did you mean".
 * A misspelt flag is never what the operator meant, so we fail rather than
 * warn, but failing without a suggestion wastes a round trip.
 */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, i) => i);

  for (let i = 1; i < rows; i++) {
    const current = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      const substitution =
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current[j] = Math.min(substitution, deletion, insertion);
    }
    previous = current;
  }

  return previous[cols - 1] ?? Math.max(a.length, b.length);
}

function suggest(unknown: string, known: string[]): string | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const name of known) {
    const distance = editDistance(unknown, name);
    if (distance <= 3 && (best === undefined || distance < best.distance)) {
      best = { name, distance };
    }
  }
  return best?.name;
}

function coerce(name: string, spec: FlagSpec, raw: string): string | number {
  switch (spec.arity) {
    case 'number':
      return requireInteger(name, raw);

    case 'cents':
      // §13.3 — an amount is a signed integer number of cents, everywhere,
      // always. A value containing '.' is rejected with the integer the
      // operator probably meant, because "--amount 500" silently meaning $5.00
      // is the kind of surprise that costs a day to find.
      if (raw.includes('.')) {
        const asDollars = Number(raw);
        const probably = Number.isFinite(asDollars)
          ? ` Did you mean --${name} ${Math.round(asDollars * 100)}?`
          : '';
        throw usageError(
          `--${name} takes integer CENTS, not dollars, and "${raw}" has a decimal point.${probably}`,
          'amounts are integer cents everywhere: -12350 is -$123.50',
        );
      }
      return requireInteger(name, raw);

    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw usageError(`--${name} takes a date as YYYY-MM-DD, got "${raw}".`);
      }
      return raw;

    case 'string':
    case 'path':
      return raw;

    case 'boolean':
      // Booleans never consume a token, so reaching here is a caller bug.
      throw usageError(`--${name} takes no value.`);

    default:
      // Exhaustive over FlagArity today; this catches a new arity added
      // without a coercion, which would otherwise pass the raw string
      // through unvalidated.
      throw usageError(`--${name} has an unsupported value type.`);
  }
}

function requireInteger(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw usageError(`--${name} takes an integer, got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Parse argv against the flags a verb actually declares.
 *
 * `specs` is the union of the verb's own flags and the universal set, built by
 * the caller — so an unknown flag here is genuinely unknown, not merely
 * belonging to a different verb.
 */
export function parseArgs(argv: string[], specs: FlagSpecs): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | number | boolean | string[]>();
  const known = Object.keys(specs);

  let sawTerminator = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';

    // Everything after `--` is a positional, so a path that starts with a
    // dash can still be passed.
    if (token === '--') {
      sawTerminator = true;
      continue;
    }
    if (sawTerminator || !isFlagToken(token)) {
      positionals.push(token);
      continue;
    }

    // --flag=value is accepted alongside --flag value.
    const equals = token.indexOf('=');
    const name =
      equals === -1 ? flagName(token) : flagName(token.slice(0, equals));
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);

    const spec = specs[name];
    if (spec === undefined) {
      const did = suggest(name, known);
      throw usageError(
        `Unknown flag --${name}.`,
        did === undefined
          ? 'abx help <verb> lists the flags this verb takes'
          : `did you mean --${did}?`,
      );
    }

    if (spec.arity === 'boolean') {
      if (inlineValue !== undefined) {
        throw usageError(
          `--${name} takes no value, but got "--${name}=${inlineValue}".`,
        );
      }
      flags.set(name, true);
      continue;
    }

    let raw = inlineValue;
    if (raw === undefined) {
      const next = argv[i + 1];
      if (next === undefined || isFlagToken(next)) {
        throw usageError(
          `--${name} needs a value.`,
          `abx help <verb> — --${name} takes a ${spec.arity}`,
        );
      }
      raw = next;
      i++;
    }

    const value = coerce(name, spec, raw);
    if (spec.repeatable === true) {
      const existing = flags.get(name);
      const list = Array.isArray(existing) ? existing : [];
      list.push(String(value));
      flags.set(name, list);
    } else {
      flags.set(name, value);
    }
  }

  return { positionals, flags };
}

/** Typed accessors, so a verb never reaches into the Map and casts. */
export function getString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
}

export function getNumber(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags.get(name);
  return typeof value === 'number' ? value : undefined;
}

export function getBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function requireString(args: ParsedArgs, name: string): string {
  const value = getString(args, name);
  if (value === undefined) {
    throw new CliError(Exit.usage, `--${name} is required.`);
  }
  return value;
}
