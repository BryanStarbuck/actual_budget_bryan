// Record → line(s) — pm/error_err.mdx §3.2.
//
//   [ts] [LEVEL] [app] [where] doing — Name: message (code=…) {k=v …} | cause: …
//       at frame
//       at frame

import { capMiddle, RECORD_CAP, stripControlChars } from './describe.ts';

export type ErrorLevel = 'WARN' | 'ERROR' | 'FATAL' | 'EXPECTED';

export const LEVELS: readonly ErrorLevel[] = [
  'WARN',
  'ERROR',
  'FATAL',
  'EXPECTED',
];

/** One fault, already described and redacted. Plain data: it crosses postMessage, fetch and IPC. */
export type ErrorRecord = {
  ts: string;
  level: ErrorLevel;
  /** The runtime (§3.3). Empty until a sink stamps it. */
  app: string;
  /** Repo-relative source path (R14). */
  where: string;
  /** Gerund phrase: what was being done. */
  doing: string;
  /** `Name: message (code=…)` — '' for a WARN with no error. */
  error: string;
  /** ` | cause: …` chain, '' when there is none. */
  cause: string;
  /** Trimmed, indented stack lines, '' when there is none. */
  stack: string;
  /** Allowlisted, redacted primitives (§11). */
  data: Record<string, string> | null;
};

/** The data block is capped here. */
export const DATA_CAP = 1000;

function field(value: string): string {
  return stripControlChars(value);
}

export function formatData(data: Record<string, string> | null): string {
  if (!data) return '';
  const pairs = Object.keys(data).map(
    k => `${field(k)}=${field(data[k] ?? '')}`,
  );
  if (!pairs.length) return '';
  return ` {${capMiddle(pairs.join(' '), DATA_CAP)}}`;
}

/** The single header line (no trailing newline). */
export function formatHeader(record: ErrorRecord): string {
  const head =
    `[${field(record.ts)}] [${field(record.level)}] [${field(record.app || '?')}] ` +
    `[${field(record.where)}] ${field(record.doing)}`;
  const error = record.error ? ` — ${field(record.error)}` : '';
  return head + error + formatData(record.data) + field(record.cause);
}

/** The whole record: header plus indented stack lines, capped at RECORD_CAP, newline-terminated. */
export function formatRecord(record: ErrorRecord): string {
  const header = formatHeader(record);
  const text = record.stack ? `${header}\n${record.stack}` : header;
  if (text.length <= RECORD_CAP) return `${text}\n`;
  // Keep the header whole if possible; cut the stack.
  if (header.length >= RECORD_CAP) return `${capMiddle(header, RECORD_CAP)}\n`;
  return `${text.slice(0, RECORD_CAP)}\n`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** HH:MM:SS (UTC, like the timestamps) for the folded summary's "first at". */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

/** The `error` text of a folded summary line (§3.2). */
export function summaryText(
  count: number,
  windowMs: number,
  firstAt: number,
  headline: string,
): string {
  const window =
    windowMs >= 60_000 && windowMs % 60_000 === 0 && windowMs > 60_000
      ? `${windowMs / 60_000}m`
      : `${Math.round(windowMs / 1000)}s`;
  const what = headline ? `: ${headline}` : '';
  return `×${count} more in the previous ${window} (first at ${clockTime(firstAt)})${what}`;
}
