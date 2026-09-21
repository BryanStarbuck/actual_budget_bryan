// GENERATED from packages/error-file — run scripts/sync-error-file.mjs
// NODE ONLY — POST /error-report, the loopback-only ingest route (pm/error_err.mdx §8).
//
// Mounted by the Vite dev server (vite-plugin.ts) and by the sync server (app.ts). Guards, in
// order: loopback only → content type → 64 KiB body cap → 50 events → rate limit → sanitize +
// re-redact → tag `via` → write through the node sink. It ALWAYS answers 204 and never echoes
// anything back: nothing about the route is probe-able.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { writeRecord } from './core.ts';
import type { ErrorRecord } from './core.ts';
import {
  capMiddle,
  MESSAGE_CAP,
  RECORD_CAP,
  stripControlChars,
} from './describe.ts';
import { unrefTimer } from './fold.ts';
import { LEVELS } from './format.ts';
import type { ErrorLevel } from './format.ts';
import { redactData, redactUrls } from './redact.ts';

export const BODY_CAP = 64 * 1024;
export const EVENTS_PER_REQUEST = 50;
export const RATE_PER_CLIENT = 240;
export const RATE_GLOBAL = 1200;
const RATE_WINDOW_MS = 60_000;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export type IngestOptions = {
  /** Tag added to every record's data: 'vite' or 'sync-server' (§3.3). */
  via: string;
  /** Test seam: the clock. */
  now?: () => number;
};

type Next = (err?: unknown) => void;
type Handler = (req: IncomingMessage, res: ServerResponse, next?: Next) => void;

function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function str(value: unknown, cap: number): string {
  return typeof value === 'string'
    ? capMiddle(stripControlChars(value), cap)
    : '';
}

function isLevel(value: unknown): value is ErrorLevel {
  return typeof value === 'string' && LEVELS.some(level => level === value);
}

function sanitizeStack(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .split('\n')
    .slice(0, 24)
    .map(line => stripControlChars(line).trim())
    .filter(line => line.length > 0)
    .map(line => `    ${line.slice(0, 400)}`)
    .join('\n');
}

/** §8.2 step 6: never trust the browser's own sanitising or redaction. */
export function sanitizeEvent(
  event: unknown,
  app: string,
  via: string,
): ErrorRecord | null {
  if (typeof event !== 'object' || event === null) return null;
  const level = prop(event, 'level');
  const ts = prop(event, 'ts');
  const data = redactData(prop(event, 'data')) ?? {};
  data.via = via;
  const eventApp = str(prop(event, 'app'), 40);
  return {
    ts: typeof ts === 'string' && ISO.test(ts) ? ts : new Date().toISOString(),
    level: isLevel(level) && level !== 'FATAL' ? level : 'ERROR',
    app: eventApp || app || 'web',
    where: str(prop(event, 'where'), 200) || '(browser)',
    doing: str(prop(event, 'doing'), 200) || 'an unspecified browser operation',
    error: redactUrls(str(prop(event, 'error'), MESSAGE_CAP)),
    cause: redactUrls(str(prop(event, 'cause'), MESSAGE_CAP)),
    stack: sanitizeStack(prop(event, 'stack')).slice(0, RECORD_CAP / 2),
    data,
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  return typeof address === 'string' && LOOPBACK.has(address);
}

function acceptedType(req: IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').toLowerCase();
  return type.startsWith('application/json') || type.startsWith('text/plain');
}

function readBody(req: IncomingMessage): Promise<string | null> {
  // A body parser mounted earlier (express.json / text) already consumed the stream.
  const parsed = prop(req, 'body');
  if (typeof parsed === 'string') {
    return Promise.resolve(parsed.length > BODY_CAP ? null : parsed);
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Object.keys(parsed).length > 0
  ) {
    try {
      const json = JSON.stringify(parsed);
      return Promise.resolve(json.length > BODY_CAP ? null : json);
    } catch {
      return Promise.resolve(null);
    }
  }
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_CAP) {
        finish(null);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => finish(null));
  });
}

/**
 * The shared ingest step: take a body (already parsed) from a browser or the Electron IPC bridge,
 * and write what survives the caps, the rate limit and the sanitiser.
 */
export type IngestSink = {
  accept(body: unknown, client: string): void;
};

export function createIngest(opts: IngestOptions): IngestSink {
  const now = opts.now ?? Date.now;
  let windowStart = 0;
  let globalCount = 0;
  const perClient = new Map<string, number>();
  let dropped = 0;
  let summaryTimer: ReturnType<typeof setTimeout> | null = null;

  function writeDropSummary(): void {
    summaryTimer = null;
    if (dropped === 0) return;
    const count = dropped;
    dropped = 0;
    writeRecord({
      ts: new Date(now()).toISOString(),
      level: 'WARN',
      app: opts.via,
      where: 'error-file/src/ingest.ts',
      doing: 'receiving browser error reports',
      error: `dropped ${count} browser reports over the rate limit`,
      cause: '',
      stack: '',
      data: { via: opts.via },
    });
  }

  function drop(count: number): void {
    if (count <= 0) return;
    dropped += count;
    if (summaryTimer === null) {
      summaryTimer = setTimeout(writeDropSummary, RATE_WINDOW_MS);
      unrefTimer(summaryTimer);
    }
  }

  function admit(key: string): boolean {
    const t = now();
    if (t - windowStart >= RATE_WINDOW_MS) {
      windowStart = t;
      globalCount = 0;
      perClient.clear();
    }
    const used = perClient.get(key) ?? 0;
    if (used >= RATE_PER_CLIENT || globalCount >= RATE_GLOBAL) return false;
    perClient.set(key, used + 1);
    globalCount += 1;
    return true;
  }

  return {
    accept(body, client) {
      try {
        const app = str(prop(body, 'app'), 40);
        const events = prop(body, 'events');
        if (!Array.isArray(events)) return;
        const accepted = events.slice(0, EVENTS_PER_REQUEST);
        drop(events.length - accepted.length);
        for (const event of accepted) {
          const record = sanitizeEvent(event, app, opts.via);
          if (!record) continue;
          if (!admit(`${record.app}|${client}`)) {
            drop(1);
            continue;
          }
          writeRecord(record);
        }
      } catch {
        // R11: the ingest route never throws into its host
      }
    },
  };
}

/** Connect/Express middleware for `POST /error-report`. Always answers 204. */
export function createErrorReportHandler(opts: IngestOptions): Handler {
  const ingest = createIngest(opts);
  return (req, res) => {
    const answer = (): void => {
      try {
        if (!res.headersSent) {
          res.statusCode = 204;
          res.end();
        }
      } catch {
        // the client went away; nothing to do
      }
    };
    try {
      if (req.method !== 'POST' || !isLoopback(req) || !acceptedType(req)) {
        req.resume();
        answer();
        return;
      }
      readBody(req).then(
        text => {
          if (text !== null) {
            try {
              ingest.accept(JSON.parse(text), req.socket?.remoteAddress ?? '?');
            } catch {
              // malformed JSON is dropped, silently
            }
          }
          answer();
        },
        () => answer(),
      );
    } catch {
      answer();
    }
  };
}
