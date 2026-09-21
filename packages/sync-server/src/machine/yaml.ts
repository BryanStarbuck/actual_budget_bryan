/**
 * A tiny YAML emitter — for the one document this plane writes as YAML, the
 * category tree (pm/apis.mdx §8.4a).
 *
 * Hand-written rather than a dependency for the same reason validate.ts is:
 * this package has no YAML library, and adding one to a published server for
 * a single fixed-shape document is a poor trade. The shape is ours and closed
 * (maps, lists, strings, integers, booleans), so the emitter only has to be
 * right about ONE hard thing: when a string must be quoted.
 *
 * THE QUOTING RULE, stated conservatively on purpose: a string is written
 * plain only when it is obviously a plain string to every YAML 1.1 and 1.2
 * parser — it starts with a letter or underscore, contains only letters,
 * digits, spaces and `_ . / ( ) + , ' -`, has no leading or trailing space,
 * and is not a word some parser reads as a boolean or null. Everything else
 * is double-quoted with JSON escaping, which is valid YAML. Quoting a string
 * that did not need it costs two characters; failing to quote one that did
 * turns a category called `Yes` into `true` or `Travel: Air` into a map.
 */

/** Words YAML 1.1 reads as booleans or null. Compared case-insensitively. */
const RESERVED = new Set([
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'y',
  'n',
  'null',
  '~',
]);

const PLAIN = /^[A-Za-z_][A-Za-z0-9 _./()+,'-]*$/;

/** A string that is always written quoted — ids, so a hex id never reads as a number. */
export class Quoted {
  constructor(readonly value: string) {}
}

/**
 * A UTC timestamp written plain (`2026-09-21T22:00:00Z`), which YAML reads as
 * a timestamp — the shared shape writes `generated_at` that way. Anything that
 * is not exactly that pattern is refused rather than written unquoted.
 */
export class Timestamp {
  constructor(readonly value: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
      throw new Error(`Not a UTC timestamp: ${value}`);
    }
  }
}

export function quoteIfNeeded(text: string): string {
  if (
    PLAIN.test(text) &&
    text === text.trim() &&
    !text.includes('  ') &&
    !RESERVED.has(text.toLowerCase())
  ) {
    return text;
  }
  return JSON.stringify(text);
}

function scalar(value: unknown): string {
  if (value instanceof Quoted) {
    return JSON.stringify(value.value);
  }
  if (value instanceof Timestamp) {
    return value.value;
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Cannot write ${value} as YAML.`);
    }
    return String(value);
  }
  return quoteIfNeeded(String(value));
}

function isMap(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Quoted) &&
    !(value instanceof Timestamp)
  );
}

function emitMap(map: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const k = quoteIfNeeded(key);
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${indent}${k}: []`);
      } else {
        lines.push(`${indent}${k}:`);
        lines.push(...emitList(value, `${indent}  `));
      }
    } else if (isMap(value)) {
      if (Object.keys(value).length === 0) {
        lines.push(`${indent}${k}: {}`);
      } else {
        lines.push(`${indent}${k}:`);
        lines.push(...emitMap(value, `${indent}  `));
      }
    } else {
      lines.push(`${indent}${k}: ${scalar(value)}`);
    }
  }
  return lines;
}

function emitList(list: unknown[], indent: string): string[] {
  const lines: string[] = [];
  for (const item of list) {
    if (isMap(item) && Object.keys(item).length > 0) {
      // The first key rides on the dash; the rest line up under it.
      const inner = emitMap(item, `${indent}  `);
      inner[0] = `${indent}- ${inner[0].slice(indent.length + 2)}`;
      lines.push(...inner);
    } else if (Array.isArray(item)) {
      throw new Error(
        'Nested lists are not part of any document this plane writes.',
      );
    } else {
      lines.push(`${indent}- ${isMap(item) ? '{}' : scalar(item)}`);
    }
  }
  return lines;
}

/** Emit a top-level map as a YAML document, ending in a newline. */
export function toYaml(doc: Record<string, unknown>): string {
  return `${emitMap(doc, '').join('\n')}\n`;
}
