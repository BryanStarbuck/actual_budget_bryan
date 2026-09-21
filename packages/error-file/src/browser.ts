// BROWSER ONLY — the browser/worker sink (pm/error_err.mdx §4.4, §8, R8).
//
// A browser tab and a web worker have no filesystem. Records are batched and POSTed to the
// loopback-only ingest route (`/error-report`), which the Vite dev server and the sync server both
// mount. In Electron the renderer hands batches to the preload bridge instead (`transport`).

import { errorFileFor, flushErrorFile, setErrorSink } from './core.ts';
import type { ErrorRecord, ErrorSink } from './core.ts';
import { unrefTimer } from './fold.ts';

export type BrowserErrorFileOptions = {
  /** 'web', 'worker' or 'electron-renderer' (§3.3). */
  app: string;
  /** Default '/error-report'. */
  endpoint?: string;
  /** Install `error` / `unhandledrejection` listeners on window / self. Default true. */
  handleGlobalErrors?: boolean;
  /** The repo-relative path global-handler records report as. */
  where?: string;
  /** Deliver a batch some other way (Electron IPC). Replaces fetch and sendBeacon. */
  transport?: (body: BrowserReportBody) => void;
  /** Echo to the DevTools console. Default false; hosts pass their dev flag. */
  echo?: boolean;
  /** Test seam: the global scope (window or self). */
  scope?: BrowserScope;
};

export type BrowserReportBody = { app: string; events: ErrorRecord[] };

/** The slice of window / WorkerGlobalScope this file uses. */
export type BrowserScope = {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  navigator?: { sendBeacon?: (url: string, data: Blob | string) => boolean };
  document?: { visibilityState?: string };
};

/** Flush when this many records are queued … */
export const BATCH_SIZE = 20;
/** … or this long after the first one. */
export const BATCH_DELAY_MS = 2000;
/** Client budget: records per minute. The rest are counted and sent as one summary. */
export const CLIENT_BUDGET_PER_MINUTE = 30;

const RESIZE_OBSERVER = /ResizeObserver loop/;

function readProp(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

/** §10.3: benign browser conditions that are never written. */
export function isBenignBrowserError(event: unknown): boolean {
  const error = readProp(event, 'error');
  const message = readProp(event, 'message');
  if ((error === null || error === undefined) && typeof message === 'string') {
    if (RESIZE_OBSERVER.test(message)) return true;
  }
  const filename = readProp(event, 'filename');
  if (typeof filename === 'string' && filename.includes('/@vite/client')) {
    return true;
  }
  const stack = readProp(error, 'stack');
  if (typeof stack === 'string' && stack.includes('/@vite/client')) return true;
  return false;
}

function defaultScope(): BrowserScope | null {
  const g: { addEventListener?: unknown } = globalThis;
  if (typeof g.addEventListener !== 'function') return null;
  // A window or a worker global — both satisfy BrowserScope structurally.
  const scope: unknown = globalThis;
  return isScope(scope) ? scope : null;
}

function isScope(value: unknown): value is BrowserScope {
  return typeof readProp(value, 'addEventListener') === 'function';
}

let installedApp: string | null = null;

/** Install the browser sink. Idempotent: a second call is ignored. Never throws. */
export function installBrowserErrorFile(opts: BrowserErrorFileOptions): void {
  if (installedApp !== null) return;
  const scope = opts.scope ?? defaultScope();
  const endpoint = opts.endpoint ?? '/error-report';
  const app = opts.app;
  installedApp = app;

  let queue: ErrorRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let budgetWindowStart = 0;
  let budgetUsed = 0;
  let overBudget = 0;
  let deliveryWarned = false;

  function warnOnce(err: unknown): void {
    if (deliveryWarned) return;
    deliveryWarned = true;
    try {
      console.warn('[error-file] could not deliver error reports', err);
    } catch {
      // silence
    }
  }

  function send(useBeacon: boolean): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (overBudget > 0) {
      queue.push({
        ts: new Date().toISOString(),
        level: 'WARN',
        app,
        where: 'error-file/src/browser.ts',
        doing: 'reporting browser errors',
        error: `${overBudget} records dropped over the client budget of ${CLIENT_BUDGET_PER_MINUTE}/min`,
        cause: '',
        stack: '',
        data: null,
      });
      overBudget = 0;
    }
    if (!queue.length) return;
    const body: BrowserReportBody = { app, events: queue };
    queue = [];
    // R11: a delivery failure is silent (one console.warn per session) and never re-queued.
    try {
      if (opts.transport) {
        opts.transport(body);
        return;
      }
      const json = JSON.stringify(body);
      const beacon = scope?.navigator?.sendBeacon;
      if (useBeacon && typeof beacon === 'function') {
        const payload =
          typeof Blob === 'function'
            ? new Blob([json], { type: 'text/plain' })
            : json;
        if (beacon.call(scope?.navigator, endpoint, payload)) return;
      }
      const doFetch = scope?.fetch;
      if (typeof doFetch !== 'function') return;
      doFetch
        .call(scope, endpoint, {
          method: 'POST',
          keepalive: true,
          headers: { 'content-type': 'application/json' },
          body: json,
        })
        .then(undefined, warnOnce);
    } catch (e) {
      warnOnce(e);
    }
  }

  function withinBudget(): boolean {
    const now = Date.now();
    if (now - budgetWindowStart >= 60_000) {
      budgetWindowStart = now;
      budgetUsed = 0;
    }
    if (budgetUsed >= CLIENT_BUDGET_PER_MINUTE) {
      overBudget += 1;
      return false;
    }
    budgetUsed += 1;
    return true;
  }

  const sink: ErrorSink = {
    app,
    echo: opts.echo ?? false,
    verbose: false,
    write(record) {
      if (!withinBudget()) return;
      queue.push(record);
      if (queue.length >= BATCH_SIZE) {
        send(false);
        return;
      }
      if (timer === null) {
        timer = setTimeout(() => send(false), BATCH_DELAY_MS);
        unrefTimer(timer);
      }
    },
    flush() {
      send(true);
    },
  };
  setErrorSink(sink);

  if (!scope) return;
  try {
    const onHide = (): void => flushErrorFile();
    if (scope.document) {
      scope.addEventListener('pagehide', onHide);
      scope.addEventListener('visibilitychange', () => {
        if (scope.document?.visibilityState === 'hidden') onHide();
      });
    }
    if (opts.handleGlobalErrors ?? true) {
      const errors = errorFileFor(opts.where ?? `${app} (global)`);
      scope.addEventListener('error', event => {
        if (isBenignBrowserError(event)) return;
        const error = readProp(event, 'error');
        errors.caught(
          'an uncaught error',
          error === null || error === undefined
            ? readProp(event, 'message')
            : error,
        );
      });
      scope.addEventListener('unhandledrejection', event => {
        errors.caught(
          'an unhandled promise rejection',
          readProp(event, 'reason'),
        );
      });
    }
  } catch {
    // no listeners — the sink still works
  }
}

/** Test seam: allow a second install. */
export function resetBrowserErrorFileForTests(): void {
  installedApp = null;
  setErrorSink(null);
}
