/**
 * Gate 5 — input validation — pm/apis.mdx §4.7, §5.7.
 *
 * Named `validate.ts` and not `schema.ts` (as apis.mdx §3.1 first had it)
 * because `/schema` is also a ROUTE — the one that describes the AQL tables
 * `/query` may name — and two different things called "schema" one directory
 * apart is a question every future reader has to stop and answer.
 *
 * Hand-written validators, one per route, deliberately not a schema library.
 * This package has no validation dependency, adding one to a published server
 * for six routes is a poor trade, and the error messages a hand-written
 * validator produces are the ones §5.4 asks for — a remediation, in the
 * caller's own vocabulary, naming the field.
 *
 * THE RULE THAT MATTERS MOST HERE: an unknown field is REJECTED, not ignored.
 * A typo'd `start_date` that silently means "no filter" is how somebody
 * imports a decade into one month, and ignoring unknown input is the default
 * behaviour of almost every parser, so it has to be actively prevented.
 */
import { MachineError } from './envelope.js';

export type Validator<T> = (input: unknown, where: 'body' | 'query') => T;

function fail(message: string, hint: string): never {
  throw new MachineError('invalid_input', message, hint);
}

function asObject(input: unknown, where: string): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail(
      `The ${where} must be a JSON object.`,
      'send an object, not an array or a scalar',
    );
  }
  return input as Record<string, unknown>;
}

/**
 * The whole of gate 5 for a route that takes nothing.
 *
 * Not a no-op: a caller sending arguments to a route that has none has
 * misunderstood something, and saying so now is cheaper than the bug report
 * about the filter that "did nothing".
 */
export function takesNothing(): Validator<Record<string, never>> {
  return (input, where) => {
    const obj = asObject(input, where);
    const extra = Object.keys(obj);
    if (extra.length > 0) {
      fail(
        `This route takes no arguments, but received: ${extra.join(', ')}.`,
        'remove them — see GET /machine/v1/capabilities for the routes that do take arguments',
      );
    }
    return {} as Record<string, never>;
  };
}

export type FieldSpec =
  | {
      type: 'string';
      required?: boolean;
      enum?: readonly string[];
      maxLength?: number;
    }
  | { type: 'integer'; required?: boolean; min?: number; max?: number }
  | { type: 'boolean'; required?: boolean }
  /**
   * A list. Only the container is checked here; the route validates each
   * item itself, because an item's shape (a transaction, an account) is the
   * route's contract and belongs next to the code that consumes it.
   */
  | { type: 'array'; required?: boolean; maxItems?: number };

/**
 * Build a validator from a flat field map.
 *
 * `query` and `body` are validated by the SAME function, because a filter that
 * means one thing as a query string and another as JSON is a filter two
 * callers will disagree about. Query strings arrive as strings, so booleans
 * and integers are coerced here and nowhere else.
 */
export function fields<T extends Record<string, unknown>>(
  spec: Record<string, FieldSpec>,
): Validator<T> {
  return (input, where) => {
    const obj = asObject(input, where);

    const unknown = Object.keys(obj).filter(k => !(k in spec));
    if (unknown.length > 0) {
      const known = Object.keys(spec);
      fail(
        `Unknown ${where} field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`,
        known.length === 0
          ? 'this route takes no arguments'
          : `this route accepts: ${known.join(', ')}`,
      );
    }

    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(spec)) {
      const raw = obj[name];

      if (raw === undefined || raw === '') {
        if (field.required) {
          fail(
            `Missing required field: ${name}.`,
            `pass ${name} in the ${where}`,
          );
        }
        continue;
      }

      out[name] = coerce(name, raw, field, where);
    }

    return out as T;
  };
}

function coerce(
  name: string,
  raw: unknown,
  field: FieldSpec,
  where: string,
): unknown {
  switch (field.type) {
    case 'string': {
      if (typeof raw !== 'string') {
        fail(
          `${name} must be a string.`,
          `pass ${name} as a string in the ${where}`,
        );
      }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        fail(
          `${name} is longer than ${field.maxLength} characters.`,
          `shorten ${name}`,
        );
      }
      if (field.enum !== undefined && !field.enum.includes(raw)) {
        fail(
          `${name} must be one of: ${field.enum.join(', ')}.`,
          `pass one of those values for ${name}`,
        );
      }
      return raw;
    }

    case 'boolean': {
      // Query strings have no booleans. Accept the two spellings a caller
      // could reasonably send and refuse everything else rather than treating
      // "false" as truthy, which is the classic version of this bug.
      if (typeof raw === 'boolean') {
        return raw;
      }
      if (raw === 'true' || raw === '1') {
        return true;
      }
      if (raw === 'false' || raw === '0') {
        return false;
      }
      fail(
        `${name} must be true or false.`,
        `pass ${name}=true or ${name}=false`,
      );
      return false;
    }

    case 'integer': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(value)) {
        fail(
          `${name} must be a whole number.`,
          'money is an integer number of cents, and counts are integers — never a decimal',
        );
      }
      if (field.min !== undefined && value < field.min) {
        fail(`${name} must be at least ${field.min}.`, `raise ${name}`);
      }
      if (field.max !== undefined && value > field.max) {
        fail(`${name} must be at most ${field.max}.`, `lower ${name}`);
      }
      return value;
    }

    case 'array': {
      if (!Array.isArray(raw)) {
        fail(`${name} must be an array.`, `pass ${name} as a JSON array`);
      }
      if (field.maxItems !== undefined && raw.length > field.maxItems) {
        fail(
          `${name} has ${raw.length} items, over the cap of ${field.maxItems}.`,
          `send ${name} in batches of at most ${field.maxItems}`,
        );
      }
      return raw;
    }

    default:
      // Unreachable while FieldSpec is a closed union, and present so that
      // ADDING a member to that union is a compile error here rather than a
      // field that silently validates as anything.
      return fail(
        `${name} has an unsupported field type.`,
        'this is a bug in the route definition, not in your request',
      );
  }
}
