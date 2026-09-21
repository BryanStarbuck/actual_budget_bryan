// The report path — pm/error_err.mdx §4.2, §5.
//
// Nothing in this file runs until an error happens (R3). `errorFileFor` builds one small object per
// module; every method runs only inside a catch. The report path is:
//
//   already reported? → mark (WeakSet) → fold? → describe + redact → sink (or pre-install queue)
//
// STATE IS PROCESS-GLOBAL, NOT MODULE-GLOBAL. The sink, the pre-install queue, the WeakSet and the
// fold table live on `globalThis` under a registry symbol. One process can load this module more
// than once — the Electron utility process installs the sink from its own compiled copy while the
// loot-core bundle it imports carries another; the sync server hosts the api's bundled copy — and
// every copy must see the same sink and the same "already reported" set, or R4 breaks.

import {
  describeCauses,
  errorHeadline,
  safeString,
  stackOf,
  trimStack,
} from './describe.ts';
import { createBurstFolder, normalizeMessage } from './fold.ts';
import type { BurstFolder, FoldSummary } from './fold.ts';
import { formatRecord, summaryText } from './format.ts';
import type { ErrorLevel, ErrorRecord } from './format.ts';
import { redactData, redactUrls } from './redact.ts';
import type { ErrorData } from './redact.ts';

export type { ErrorData, ErrorDataValue } from './redact.ts';
export type { ErrorLevel, ErrorRecord } from './format.ts';

/** Where records go once a host has booted (§4.3 node, §4.4 browser). */
export type ErrorSink = {
  /** The runtime tag stamped on records that do not carry one (§3.3). */
  app: string;
  /** Echo each written record to the console (dev/test, or ACTUAL_ERROR_FILE_ECHO=1) — §10.4. */
  echo: boolean;
  /** Write EXPECTED records too (ACTUAL_ERROR_FILE_VERBOSE=1) — R6. */
  verbose: boolean;
  write(record: ErrorRecord): void;
  /** Synchronous barrier (node) / best-effort send (browser). */
  flush(): void;
};

export type ErrorFile = {
  /** The repo-relative source path this object reports as (R14). */
  readonly where: string;
  /** ERROR → error.err. */
  caught(doing: string, err: unknown, data?: ErrorData): void;
  /** WARN → error.err. The error is optional: a standing condition can be a WARN on its own. */
  warn(doing: string, err?: unknown, data?: ErrorData): void;
  /** Nothing (EXPECTED under ACTUAL_ERROR_FILE_VERBOSE=1). The call records a DECISION — R6. */
  expected(doing: string, err: unknown): void;
  /** ERROR, then throw the SAME object (R5). */
  rethrow(doing: string, err: unknown, data?: ErrorData): never;
  /** FATAL, then a synchronous flush (node) — R9. */
  fatal(doing: string, err: unknown, data?: ErrorData): void;
};

/** Records held before any sink is installed (a module can fault at import time). */
export const PRE_INSTALL_CAP = 200;
/** R10: identical faults fold inside this window. */
export const FOLD_WINDOW_MS = 60_000;
/** §10.2: transient network faults fold per 10 minutes, as WARN. */
export const TRANSIENT_WINDOW_MS = 10 * 60_000;
/** §9: the fold table is capped. */
export const FOLD_MAX_KEYS = 1000;

type FoldContext = {
  level: ErrorLevel;
  app: string;
  where: string;
  doing: string;
  headline: string;
};

type State = {
  sink: ErrorSink | null;
  queue: ErrorRecord[];
  overflow: number;
  reported: WeakSet<object>;
  folder: BurstFolder;
  busy: boolean;
  consoleFallbackUsed: boolean;
};

const REGISTRY = Symbol.for('@actual-app/error-file/state@1');

function isFoldContext(value: unknown): value is FoldContext {
  return typeof value === 'object' && value !== null && 'headline' in value;
}

function createState(): State {
  const state: State = {
    sink: null,
    queue: [],
    overflow: 0,
    reported: new WeakSet<object>(),
    folder: createBurstFolder({
      maxKeys: FOLD_MAX_KEYS,
      emit: (summary: FoldSummary, context: unknown) => {
        if (!isFoldContext(context)) return;
        deliver(state, {
          ts: new Date().toISOString(),
          level: context.level,
          app: context.app,
          where: context.where,
          doing: context.doing,
          error: summaryText(
            summary.count,
            summary.windowMs,
            summary.firstAt,
            context.headline,
          ),
          cause: '',
          stack: '',
          data: null,
        });
      },
    }),
    busy: false,
    consoleFallbackUsed: false,
  };
  return state;
}

function state(): State {
  const holder: Record<symbol, unknown> = globalThis;
  const existing = holder[REGISTRY];
  if (
    typeof existing === 'object' &&
    existing !== null &&
    'folder' in existing
  ) {
    // Written only by createState() below, under this private registry symbol.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return existing as State;
  }
  const created = createState();
  holder[REGISTRY] = created;
  return created;
}

/** Read an environment variable in any runtime (a browser has none). */
export function readEnv(name: string): string | undefined {
  try {
    const g: { process?: { env?: Record<string, string | undefined> } } =
      globalThis;
    return g.process?.env?.[name];
  } catch {
    return undefined;
  }
}

function lastResort(message: string, err: unknown): void {
  const s = state();
  if (s.consoleFallbackUsed) return;
  s.consoleFallbackUsed = true;
  try {
    // R11: the only place left to say the file itself failed.
    console.error(`[error-file] ${message}: ${safeString(err)}`);
  } catch {
    // silence is the last fallback
  }
}

function echo(record: ErrorRecord): void {
  try {
    const line = formatRecord(record).trimEnd();
    if (record.level === 'WARN' || record.level === 'EXPECTED') {
      console.warn(line);
    } else {
      console.error(line);
    }
  } catch {
    // echo is a convenience; never let it matter
  }
}

function deliver(s: State, record: ErrorRecord): void {
  const sink = s.sink;
  if (!sink) {
    if (s.queue.length < PRE_INSTALL_CAP) s.queue.push(record);
    else s.overflow += 1;
    return;
  }
  if (!record.app) record.app = sink.app;
  try {
    sink.write(record);
  } catch (e) {
    lastResort('the error sink threw', e);
  }
  if (sink.echo) echo(record);
}

function prop(value: unknown, key: string): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return undefined;
  }
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function nameOf(err: unknown): string {
  const name = prop(err, 'name');
  return typeof name === 'string' ? name : typeof err;
}

function messageOf(err: unknown): string {
  const message = prop(err, 'message');
  return typeof message === 'string' ? message : safeString(err);
}

const TRANSIENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** §10.2 — offline is not a fault. Looks at the error and two links of its cause chain. */
export function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < 3 && current !== null && current !== undefined;
    depth++
  ) {
    if (prop(current, 'reason') === 'network-failure') return true;
    const code = prop(current, 'code');
    if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
    const message = prop(current, 'message');
    if (typeof message === 'string' && message.includes('network-failure')) {
      return true;
    }
    current = prop(current, 'cause');
  }
  return false;
}

function isMarkable(err: unknown): err is object {
  return (typeof err === 'object' && err !== null) || typeof err === 'function';
}

/** Has this exact error object already been written (R4)? */
export function isReported(err: unknown): boolean {
  try {
    return isMarkable(err) && state().reported.has(err);
  } catch {
    return false;
  }
}

type ReportArgs = {
  level: ErrorLevel;
  where: string;
  doing: string;
  err: unknown;
  hasErr: boolean;
  data: unknown;
  extraStack: string;
};

function report(args: ReportArgs): void {
  const s = state();
  // Re-entrancy: anything thrown or reported WHILE reporting is dropped, so the library can never
  // loop (R11) — a throwing getter on the error, a sink that reports, an echo that faults.
  if (s.busy) return;
  s.busy = true;
  try {
    const { where, doing, err, hasErr } = args;
    if (hasErr && isMarkable(err)) {
      if (s.reported.has(err)) return;
      s.reported.add(err);
    }
    let level = args.level;
    let windowMs = FOLD_WINDOW_MS;
    const name = hasErr ? nameOf(err) : '';
    if (level === 'ERROR' && hasErr) {
      if (isTransientNetworkError(err)) {
        level = 'WARN';
        windowMs = TRANSIENT_WINDOW_MS;
      } else if (name === 'LazyLoadFailedError') {
        level = 'WARN';
      }
    }
    const app = s.sink?.app ?? '';
    const headline = hasErr ? redactUrls(errorHeadline(err)) : '';
    if (level !== 'FATAL') {
      const key = [
        app,
        where,
        doing,
        name,
        normalizeMessage(hasErr ? messageOf(err) : ''),
      ].join('\u0001');
      const context: FoldContext = { level, app, where, doing, headline };
      if (!s.folder.admit(key, windowMs, context)) return;
    }
    const stack = hasErr ? stackOf(err) : '';
    deliver(s, {
      ts: new Date().toISOString(),
      level,
      app,
      where,
      doing,
      error: headline,
      cause: hasErr ? redactUrls(describeCauses(err)) : '',
      stack: args.extraStack
        ? stack
          ? `${args.extraStack}\n${stack}`
          : args.extraStack
        : stack,
      data: redactData(args.data),
    });
  } catch (e) {
    lastResort('could not report an error', e);
  } finally {
    s.busy = false;
  }
}

/**
 * Write an already-built record (the ingest route, the Electron IPC bridge). It is folded like any
 * other record, but not de-duplicated: it has no Error object left to remember.
 */
export function writeRecord(record: ErrorRecord): void {
  const s = state();
  if (s.busy) return;
  s.busy = true;
  try {
    if (record.level !== 'FATAL') {
      const key = [
        record.app,
        record.where,
        record.doing,
        normalizeMessage(record.error),
      ].join('\u0001');
      const context: FoldContext = {
        level: record.level,
        app: record.app,
        where: record.where,
        doing: record.doing,
        headline: record.error,
      };
      if (!s.folder.admit(key, FOLD_WINDOW_MS, context)) return;
    }
    deliver(s, record);
  } catch (e) {
    lastResort('could not write a record', e);
  } finally {
    s.busy = false;
  }
}

/** Install (or with null, remove) the sink, and drain the pre-install queue into it. */
export function setErrorSink(sink: ErrorSink | null): void {
  try {
    const s = state();
    s.sink = sink;
    if (!sink) return;
    const queued = s.queue;
    const overflow = s.overflow;
    s.queue = [];
    s.overflow = 0;
    for (const record of queued) deliver(s, record);
    if (overflow > 0) {
      deliver(s, {
        ts: new Date().toISOString(),
        level: 'WARN',
        app: sink.app,
        where: 'error-file/src/core.ts',
        doing: 'installing the error file',
        error: `${overflow} records were dropped before the error file was installed`,
        cause: '',
        stack: '',
        data: null,
      });
    }
  } catch (e) {
    lastResort('could not install the error sink', e);
  }
}

/** Is a sink installed in this process (by any copy of this module)? */
export function hasErrorSink(): boolean {
  try {
    return state().sink !== null;
  } catch {
    return false;
  }
}

/** Write every owed fold summary, then flush the sink synchronously (node). */
export function flushErrorFile(): void {
  try {
    const s = state();
    s.folder.flushAll();
    s.sink?.flush();
  } catch (e) {
    lastResort('could not flush the error file', e);
  }
}

/** Test seam: forget the sink, the queue, the fold table and the reported set. */
export function resetErrorFileForTests(): void {
  const s = state();
  s.folder.reset();
  s.sink = null;
  s.queue = [];
  s.overflow = 0;
  s.reported = new WeakSet<object>();
  s.busy = false;
  s.consoleFallbackUsed = false;
}

function isVerbose(): boolean {
  return (
    state().sink?.verbose === true ||
    readEnv('ACTUAL_ERROR_FILE_VERBOSE') === '1'
  );
}

/** One object per module, created at module scope: `const errors = errorFileFor('<path>')`. */
export function errorFileFor(where: string): ErrorFile {
  return {
    where,
    caught(doing, err, data) {
      report({
        level: 'ERROR',
        where,
        doing,
        err,
        hasErr: true,
        data,
        extraStack: '',
      });
    },
    warn(doing, err, data) {
      report({
        level: 'WARN',
        where,
        doing,
        err,
        hasErr: err !== undefined,
        data,
        extraStack: '',
      });
    },
    expected(doing, err) {
      if (!isVerbose()) return;
      report({
        level: 'EXPECTED',
        where,
        doing,
        err,
        hasErr: true,
        data: null,
        extraStack: '',
      });
    },
    rethrow(doing, err, data) {
      report({
        level: 'ERROR',
        where,
        doing,
        err,
        hasErr: true,
        data,
        extraStack: '',
      });
      throw err;
    },
    fatal(doing, err, data) {
      report({
        level: 'FATAL',
        where,
        doing,
        err,
        hasErr: true,
        data,
        extraStack: '',
      });
      flushErrorFile();
    },
  };
}

// ── The wrappers (§5, patterns 4–7) ─────────────────────────────────────────────────────────────

/** Run `fn`; on a throw, report it and return `fallback`. */
export function tryOr<T>(
  errors: ErrorFile,
  doing: string,
  fn: () => T,
  fallback: T,
): T {
  try {
    return fn();
  } catch (e) {
    errors.caught(doing, e);
    return fallback;
  }
}

/** Await `fn()`; on a rejection, report it and resolve to `fallback`. */
export async function tryOrAsync<T>(
  errors: ErrorFile,
  doing: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errors.caught(doing, e);
    return fallback;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof prop(value, 'then') === 'function'
  );
}

/** A fire-and-forget promise: report its rejection instead of losing it. */
export function reportRejection(
  errors: ErrorFile,
  doing: string,
  p: unknown,
): void {
  if (!isThenable(p)) return;
  try {
    p.then(undefined, (e: unknown) => errors.caught(doing, e));
  } catch (e) {
    errors.caught(doing, e);
  }
}

/**
 * Wrap a callback nobody awaits (timer, listener, onmessage). Reports a synchronous throw AND a
 * rejected promise the callback returns. Allocates once, at wrap time — never call it in render.
 */
export function guard<A extends unknown[]>(
  errors: ErrorFile,
  doing: string,
  fn: (...a: A) => unknown,
): (...a: A) => void {
  return (...a: A) => {
    try {
      const result = fn(...a);
      if (isThenable(result)) reportRejection(errors, doing, result);
    } catch (e) {
      errors.caught(doing, e);
    }
  };
}

/** An `onError` for react-error-boundary; the component stack becomes the first frames. */
export function reportBoundaryError(
  errors: ErrorFile,
  doing: string,
): (
  error: unknown,
  info?: { componentStack?: string | null | undefined },
) => void {
  const where = errors.where;
  return (error, info) => {
    const componentStack = info?.componentStack;
    report({
      level: 'ERROR',
      where,
      doing,
      err: error,
      hasErr: true,
      data: null,
      extraStack:
        typeof componentStack === 'string' ? trimStack(componentStack, 8) : '',
    });
  };
}
