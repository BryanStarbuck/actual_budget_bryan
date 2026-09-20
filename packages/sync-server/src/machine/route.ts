/**
 * The route definition — pm/apis.mdx §6.3.
 *
 * ONE array builds the router AND `GET /capabilities`. There is no second
 * list. This is the same rule mcp.mdx §9.3 states for the tool catalogue, for
 * the same reason: a route present in one and missing from the other is a
 * caller discovering, at runtime, that the server lied about itself — and
 * `/capabilities` exists precisely so a client does not have to guess.
 */
import type { Response } from 'express';

import type { EngineState } from './engine.js';
import type { MachineRequest } from './machine-auth.js';
import type { Tier, TierGrants } from './tier.js';
import type { Validator } from './validate.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export type RouteContext<A> = {
  /** Already through gate 5. Never the raw request body. */
  args: A;
  req: MachineRequest;
  res: Response;
  grants: TierGrants;
  keyFingerprint: string;
  serverVersion: string;
  env: NodeJS.ProcessEnv;
  /** The registry, for the one route that describes it. */
  routes: readonly RouteDef[];
  engine: () => EngineState;
};

export type RouteResult = {
  data: unknown;
  /** Merged into the envelope's meta. Routes that know the budget set it here. */
  meta?: Record<string, unknown>;
};

// The handler's argument type is erased at the registry boundary on purpose:
// a heterogeneous array of routes cannot be typed per-route without a mapped
// tuple that buys nothing at runtime. Each route's own `validate` is what
// guarantees the shape, and that is asserted one line above the handler.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRouteDef = RouteDef<any>;

export type RouteDef<A = unknown> = {
  method: HttpMethod;
  /** Relative to /machine/v1, with a leading slash. Express syntax. */
  path: string;
  tier: Tier;
  /** One line, for `/capabilities`. Written for a human reading a route list. */
  summary: string;
  /**
   * `live` — implemented. `planned` — mounted, tiered and gated, but its
   * handler refuses with `not_ready` naming the phase that will build it.
   *
   * Planned routes exist so the gate ladder above them is exercised by real
   * integration tests from the phase they are declared in, rather than from
   * the phase they are implemented in. `/capabilities` publishes this, so a
   * client that reads the route table does NOT come away believing a planned
   * route works — which would be the server describing itself incorrectly,
   * the exact failure §6.3 exists to prevent.
   */
  status: 'live' | 'planned';
  /**
   * True when the route cannot answer without an initialised engine.
   *
   * The plane's own routes are false — their whole job is to report that the
   * engine is NOT ready, so requiring it would make them useless at exactly
   * the moment they are needed (§8.0).
   */
  needsEngine: boolean;
  validate: Validator<A>;
  run: (ctx: RouteContext<A>) => Promise<RouteResult>;
};

export function route<A>(def: RouteDef<A>): RouteDef<A> {
  return def;
}

export type RouteDescription = {
  path: string;
  methods: HttpMethod[];
  tier: Record<string, Tier>;
  summary: Record<string, string>;
  status: Record<string, 'live' | 'planned'>;
};

/** The machine-readable shape `/capabilities` publishes (§6.3). */
export function describeRoutes(
  routes: readonly AnyRouteDef[],
): RouteDescription[] {
  const byPath = new Map<string, RouteDescription>();

  for (const r of routes) {
    const entry = byPath.get(r.path) ?? {
      path: r.path,
      methods: [],
      tier: {},
      summary: {},
      status: {},
    };
    entry.methods.push(r.method);
    entry.tier[r.method] = r.tier;
    entry.summary[r.method] = r.summary;
    entry.status[r.method] = r.status;
    byPath.set(r.path, entry);
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
