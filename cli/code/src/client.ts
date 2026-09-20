/**
 * The one HTTP client — pm/cli.mdx §5, §7.2, and rules R3 and R6.
 *
 * Every machine-plane call goes through `call()`. Nothing else in the CLI
 * opens a socket, so the rules below are enforced in one place rather than
 * remembered in several.
 */
import { fingerprint } from './credentials.js';
import { CliError, Exit } from './exit.js';
import type { Logger } from './logger.js';

export const DEFAULT_API_URL = 'http://127.0.0.1:5006';

export type Envelope =
  | { ok: true; data: unknown; meta?: Record<string, unknown> }
  | { ok: false; error: { code: string; message?: string; hint?: string } };

export type Target = {
  baseUrl: string;
  /** `local` is the default and, today, the only mode that is not explicit (§7.2). */
  kind: 'local' | 'explicit';
};

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

export function resolveTarget(
  apiFlag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Target {
  const raw = apiFlag ?? env.ABX_API_URL;
  if (raw === undefined) {
    return { baseUrl: DEFAULT_API_URL, kind: 'local' };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(Exit.usage, `--api ${raw} is not a URL.`);
  }

  // R3 — the key is never attached to a URL that is neither loopback nor
  // https:. Checked here, before the socket opens, and the refusal names the
  // URL: `--api http://some-host:5006` would put a 256-bit secret in cleartext
  // on somebody's network, and a bare 401 would have taught the operator to
  // retry it.
  if (!isLoopbackHost(url.hostname) && url.protocol !== 'https:') {
    throw new CliError(
      Exit.usage,
      `Refusing to send the machine key to ${raw} — it is neither loopback nor https:.`,
      { hint: 'use https:, or a 127.0.0.1 address' },
    );
  }

  return { baseUrl: url.origin, kind: 'explicit' };
}

export type CallOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Omitted entirely by the long verbs (§7.4). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Audit destination (§15). Optional so `call()` stays usable in a test
   * without a state directory, but every real invocation passes it: an
   * API_CALL line per call is how "why did last night's import add nothing"
   * is answerable the next morning.
   */
  logger?: Logger;
  verb?: string;
};

/**
 * Issue one machine-plane call and return the envelope.
 *
 * Every non-2xx answer becomes a CliError carrying the right exit code, so
 * callers never branch on HTTP status. The 401 mapping is the one that earns
 * its keep — see the comment on `explain401`.
 */
export async function call(
  target: Target,
  key: string,
  route: string,
  opts: CallOptions = {},
): Promise<Envelope> {
  const url = `${target.baseUrl}/machine/v1${route}`;
  const method = opts.method ?? 'GET';
  const startedAt = Date.now();

  const controller = new AbortController();
  const timer =
    opts.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort();
        }, opts.timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'X-Actual-Machine-Key': key,
        ...(opts.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: opts.signal ?? controller.signal,
    });
  } catch (err) {
    audit(opts, target, route, method, startedAt, 'error');
    if ((err as Error).name === 'AbortError') {
      throw new CliError(Exit.unreachable, `${method} ${route} timed out.`, {
        hint: 'raise --timeout, or drop it on the long verbs',
      });
    }
    throw new CliError(
      Exit.unreachable,
      `Could not reach the machine plane at ${target.baseUrl}.`,
      { hint: 'abx up', detail: (err as Error).message },
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }

  if (response.status === 401) {
    audit(opts, target, route, method, startedAt, 'error');
    throw explain401(target, key);
  }

  // The plane 404s anything it refuses to admit exists — off loopback, from a
  // browser origin, or simply not mounted because the server booted without a
  // key (R9). A route-level not_found says so in its body; a gate-level one
  // does not, and the difference matters to the operator.
  const envelope = (await response.json().catch(() => undefined)) as
    | Envelope
    | undefined;

  if (envelope === undefined) {
    throw new CliError(
      Exit.unreachable,
      `${target.baseUrl} answered ${response.status} with no JSON body.`,
      {
        hint: 'is something other than the sync server holding that port? abx doctor',
      },
    );
  }

  if (envelope.ok) {
    audit(
      opts,
      target,
      route,
      method,
      startedAt,
      'ok',
      rowCountOf(envelope.data),
    );
    return envelope;
  }

  audit(opts, target, route, method, startedAt, 'error');
  throw new CliError(
    exitFor(envelope.error.code),
    envelope.error.message ?? envelope.error.code,
    {
      ...(envelope.error.hint === undefined
        ? {}
        : { hint: envelope.error.hint }),
    },
  );
}

function exitFor(code: string): CliError['code'] {
  switch (code) {
    case 'not_found':
      return Exit.notFound;
    case 'conflict':
      return Exit.conflict;
    case 'unauthorized':
      return Exit.unauthorized;
    case 'not_ready':
      return Exit.unreachable;
    case 'invalid_input':
    case 'write_disabled':
    case 'forbidden':
      return Exit.usage;
    default:
      return Exit.failed;
  }
}

/**
 * R6, the far side of it.
 *
 * The server's 401 body is deliberately constant and uninformative — it does
 * not know who is asking, so it says nothing. The CLI does know: it knows
 * which file it read, which target it aimed at, and which fingerprint it sent.
 * Without this, the whole failure surfaces as an opaque 401 and the operator
 * goes looking for a server problem that is not there.
 *
 * Exit 6 rather than 2 is the other half: 2 means "we never sent anything",
 * 6 means "a reachable server said no". Rotating a key to fix a 2 is a wasted
 * afternoon.
 */
function explain401(target: Target, key: string): CliError {
  return new CliError(
    Exit.unauthorized,
    `${target.baseUrl} rejected the machine key (fingerprint ${fingerprint(key)}).`,
    {
      hint: 'the server is most likely holding an older key — restart it: abx stop && abx up',
    },
  );
}

/**
 * A row count, when the payload obviously has one.
 *
 * Deliberately shallow: this is the ONLY thing about a response body that
 * reaches the log. A count of rows is safe; a payee, an amount or an account
 * number is not, and a log file is the least-protected copy of anything it
 * holds (§15).
 */
function rowCountOf(data: unknown): number | undefined {
  if (Array.isArray(data)) {
    return data.length;
  }
  return undefined;
}

function audit(
  opts: CallOptions,
  target: Target,
  route: string,
  method: string,
  startedAt: number,
  outcome: 'ok' | 'error',
  rows?: number,
): void {
  opts.logger?.apiCall({
    verb: opts.verb ?? 'unknown',
    target: target.baseUrl,
    route,
    method,
    ms: Date.now() - startedAt,
    outcome,
    ...(rows === undefined ? {} : { rows }),
  });
}
