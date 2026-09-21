/**
 * Route discovery — the machine plane's `/capabilities`.
 *
 * The plane publishes its own route table, each entry tiered and marked
 * `live` or `planned`. This server reads it so that a tool whose backing
 * route has not been built yet says exactly that, instead of the model
 * calling it and getting a bare `not_found` that looks like a bug.
 *
 * It is the same reasoning as gate 4's treatment of disabled write tools
 * (mcp.mdx §7.1): a tool that misleads is worse than a tool that is honestly
 * marked unavailable, because the model will keep trying variations of a call
 * that cannot work.
 */
import type { MachinePlaneClient } from './client.js';
import { errorFileFor } from './vendor/error-file/index.ts';

const errors = errorFileFor('mcp/src/capabilities.ts');

/**
 * - `live`    — the app implements it; go.
 * - `planned` — the app declares it and says it is not built yet.
 * - `absent`  — we HAVE the route table and this route is not in it. Strong
 *               evidence the app is older than this server's catalogue.
 * - `unknown` — we could not read the table at all, so we know nothing.
 */
export type RouteStatus = 'live' | 'planned' | 'absent' | 'unknown';

type CapabilityRoute = {
  path?: string;
  methods?: string[];
  status?: Record<string, string>;
};

export type Capabilities = {
  /** "GET /whoami" -> "live" | "planned" */
  routes: Map<string, RouteStatus>;
  tiers: { read: boolean; write: boolean; admin: boolean };
  budgetLoaded: boolean;
};

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function parse(data: unknown): Capabilities {
  const doc = (data ?? {}) as {
    routes?: CapabilityRoute[];
    tiers?: { read?: boolean; write?: boolean; admin?: boolean };
    budgetLoaded?: boolean;
  };

  const routes = new Map<string, RouteStatus>();
  for (const entry of doc.routes ?? []) {
    if (entry.path === undefined) {
      continue;
    }
    for (const method of entry.methods ?? []) {
      const raw = entry.status?.[method];
      routes.set(
        routeKey(method, entry.path),
        raw === 'live' ? 'live' : raw === 'planned' ? 'planned' : 'unknown',
      );
    }
  }

  return {
    routes,
    tiers: {
      read: doc.tiers?.read ?? true,
      write: doc.tiers?.write ?? false,
      admin: doc.tiers?.admin ?? false,
    },
    budgetLoaded: doc.budgetLoaded ?? false,
  };
}

/**
 * A lazily-fetched, refreshable view of the plane's route table.
 *
 * Lazy because the app may not be running when this server starts, and
 * refreshable because it may be restarted — with a newer build and more
 * routes — while this server stays connected for the whole conversation. A
 * cache that could only be wrong in the direction of "this does not exist"
 * would strand every tool that later became available.
 */
export class CapabilityCache {
  readonly #client: MachinePlaneClient;
  #value: Capabilities | null = null;
  #fetchedAt = 0;
  #inFlight: Promise<Capabilities | null> | null = null;

  constructor(client: MachinePlaneClient) {
    this.#client = client;
  }

  /** The last known table, without going to the network. */
  snapshot(): Capabilities | null {
    return this.#value;
  }

  async refresh(): Promise<Capabilities | null> {
    // Coalesce: tools/list plus a burst of calls must not become N requests.
    this.#inFlight ??= this.#load().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #load(): Promise<Capabilities | null> {
    try {
      const res = await this.#client.request('/capabilities');
      this.#value = parse(res.data);
      this.#fetchedAt = Date.now();
      return this.#value;
    } catch (e) {
      // Best effort. A failure here must never stop the server starting or a
      // tool running: the tool's own call will produce the real diagnosis
      // (not_ready, unauthorized) with a better message than we could.
      errors.expected('reading the machine-plane route table', e);
      return null;
    }
  }

  /**
   * Is this route usable right now?
   *
   * The distinction that matters is between "we know it is not there" and "we
   * do not know". Only the first is a reason to refuse: being unsure is not,
   * because the call itself would produce a better diagnosis than a guess.
   */
  async statusOf(method: string, path: string): Promise<RouteStatus> {
    const key = routeKey(method, path);

    if (this.#value === null) {
      await this.refresh();
    }
    if (this.#value === null) {
      return 'unknown';
    }
    if (this.#value.routes.get(key) === 'live') {
      return 'live';
    }

    // Before reporting a route as missing, re-check once if the table is more
    // than a few seconds old: the operator may have restarted the app with a
    // newer build mid-conversation, and telling them a route does not exist
    // when it now does is the more expensive mistake.
    if (Date.now() - this.#fetchedAt > 5_000) {
      await this.refresh();
    }

    const status = this.#value?.routes.get(key);
    if (status === 'live') {
      return 'live';
    }
    if (status === 'planned') {
      return 'planned';
    }
    // We have a table and this route is not in it.
    return this.#value === null ? 'unknown' : 'absent';
  }
}
