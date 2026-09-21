/**
 * The ONE http client — pm/mcp.mdx §7.0 T9, §15.
 *
 * This is the only module in the process that opens a socket, and the only
 * host it may open one to is the configured machine plane. A canary greps the
 * built bundle for host literals to keep that true.
 *
 * One HTTP call per tool call. No tool fans out; a tool that needs two routes
 * is two tools, or one new route. And no cache: the machine plane holds the
 * initialised budget, and caching here would be a second copy that can be
 * stale, which is exactly what §9.4 exists to prevent.
 */
import type { Config } from './config.js';
import { ERROR_CODES, fail } from './envelope.js';
import type { ErrorCode } from './envelope.js';

export type PlaneResponse = {
  ok: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; hint?: string };
  meta?: Record<string, unknown>;
};

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /**
   * Exempt from the per-call timeout (§14): extraction and apply are long by
   * nature, and a client that gives up at 30s reports a failure about a job
   * that is running perfectly.
   */
  noTimeout?: boolean;
};

function isMachinePlaneCode(code: string): code is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(code);
}

export class MachinePlaneClient {
  readonly #config: Config;
  readonly #key: string;

  constructor(config: Config, key: string) {
    this.#config = config;
    this.#key = key;
  }

  async request(
    route: string,
    opts: RequestOptions = {},
  ): Promise<PlaneResponse> {
    const url = new URL(`${this.#config.apiUrl}/machine/v1${route}`);
    for (const [name, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(name, String(value));
      }
    }

    const method = opts.method ?? 'GET';
    const signal = opts.noTimeout
      ? undefined
      : AbortSignal.timeout(this.#config.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          // Never in a query string — that lands in access logs and shell
          // history. Always the header (cli.mdx §4.4).
          'X-Actual-Machine-Key': this.#key,
          ...(opts.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw fail(
          'upstream_error',
          `The app did not answer ${method} ${route} within ${this.#config.timeoutMs}ms.`,
          'the request may still be running; check with the operator before retrying',
        );
      }
      // The model must be told to stop, not to retry: the app being down is
      // not a transient condition that resolves on its own (§9.8).
      throw fail(
        'not_ready',
        `The Actual Budget app is not reachable at ${this.#config.apiUrl}.`,
        'ask the operator to run `abx up`; this server does not start the app',
      );
    }

    // A byte cap before parsing, so a pathological response cannot be read
    // into memory in full (§14 ABMCP_MAX_BYTES).
    const text = await response.text();
    if (text.length > this.#config.maxBytes) {
      throw fail(
        'upstream_error',
        `The app returned ${text.length} bytes, over the ${this.#config.maxBytes} byte cap.`,
        'narrow the date range or lower the limit',
      );
    }

    let parsed: PlaneResponse;
    try {
      parsed = JSON.parse(text) as PlaneResponse;
    } catch {
      // The machine plane always answers JSON. HTML here means something else
      // is on that port, or a route fell through to a web server's fallback.
      throw fail(
        'upstream_error',
        `The app answered ${response.status} with a non-JSON body.`,
        'check that the sync server, and not something else, holds that port',
      );
    }

    if (parsed.ok) {
      return parsed;
    }

    const code = parsed.error?.code ?? '';
    if (code === 'unauthorized') {
      // Distinct from not_ready on purpose: the app IS running, it is just
      // holding a different key. The two have different fixes and a model
      // that conflates them gives the wrong instruction first (§13).
      throw fail(
        'unauthorized',
        "The app rejected this server's machine key.",
        'the app is holding an older key — ask the operator to restart it: `abx stop && abx up`',
      );
    }

    throw fail(
      isMachinePlaneCode(code) ? code : 'upstream_error',
      parsed.error?.message ?? `The app refused ${method} ${route}.`,
      parsed.error?.hint,
    );
  }
}
