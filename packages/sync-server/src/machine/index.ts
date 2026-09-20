/**
 * The machine plane — pm/apis.mdx.
 *
 * A loopback-only HTTP surface for programs rather than browsers, mounted on
 * the sync server because it is this repo's only long-running Node process.
 * `abx` and the MCP are both callers of it, so the browser, the terminal and
 * the agent all answer from one engine and cannot disagree about a balance.
 *
 * MOUNTING AND INITIALISATION ARE DELIBERATELY SEPARATE, because the two have
 * incompatible timing requirements and doing either at the wrong moment is a
 * bug that does not look like one:
 *
 *   - The ROUTER must be mounted at module scope, alongside the other
 *     `app.use('/sync', …)` mounts. Express matches in registration order, and
 *     app.ts registers an SPA catch-all — `app.get('/{*splat}', …)` — at module
 *     scope too. Anything mounted after it never runs: `/machine/v1/ping`
 *     returns index.html with a 200, so the CLI sees a successful response
 *     with no JSON body rather than a routing error.
 *
 *   - The KEY must be resolved at boot, not at import, because resolving it
 *     MINTS one into ~/.credentials/actual_budget.json when none exists.
 *     Minting at import means that merely importing this module — as every
 *     test in this package does — writes a secret into the developer's real
 *     home directory as an invisible side effect.
 *
 * So: `machineRouter` is created and mounted early and holds no key, and
 * `initMachinePlane()` is called from run() to give it one. Until that call
 * the router 404s everything, which is R9's fail-closed behaviour and not a
 * special case — an unauthenticated machine plane is never a fallback.
 *
 * The ROUTE TABLE is one array (§6.3). The router below and `/capabilities`
 * are both built from it, so the server cannot describe itself incorrectly.
 */
import express from 'express';
import type { Request, Response } from 'express';

import { fingerprint, resolveMachineKey } from './credentials-file.js';
import { engineState, requireEngine, shutdownEngine } from './engine.js';
import { MachineError, sendError, sendOk, toMachineError } from './envelope.js';
import { machineAuthMiddleware } from './machine-auth.js';
import type { MachineRequest } from './machine-auth.js';
import type { AnyRouteDef } from './route.js';
import { MAX_BODY_BYTES, planeRoutes } from './routes/plane.js';
import { plannedRoutes } from './routes/planned.js';
import { assertTier, grantsFromEnv } from './tier.js';
import type { TierGrants } from './tier.js';

export type MachinePlaneInfo = {
  keyFingerprint: string;
  allowWrite: boolean;
  allowAdmin: boolean;
  routeCount: number;
};

/** Set once, by initMachinePlane(). Null means "not mounted" to every request. */
let plane: { key: string; grants: TierGrants; env: NodeJS.ProcessEnv } | null =
  null;

/**
 * THE route table. One array, no second list.
 *
 * Later phases append their families here; nothing else changes.
 */
export const ROUTES: readonly AnyRouteDef[] = [
  ...planeRoutes,
  ...plannedRoutes,
];

const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  // `npm_package_version` is only set when the process was started by a
  // package manager script. The server is also started as `node build/app.js`
  // (which is what `just server-bg` does through yarn, and what the Docker
  // image does directly), so this has to degrade to something honest rather
  // than claiming a version it does not know.
  return process.env.npm_package_version ?? 'unknown';
}

export const machineRouter = express.Router();

/**
 * R9 — fail closed. Before init (and if init found no key) the plane does not
 * exist, and says so the same way it says so to a non-loopback caller: 404,
 * with nothing learned from probing it.
 */
machineRouter.use((_req: Request, res: Response, next) => {
  if (plane === null) {
    res.status(404).json({
      ok: false,
      error: { code: 'not_found', message: 'Not found.' },
    });
    return;
  }
  next();
});

// The gate ladder reads the key at REQUEST time, so the middleware can be
// installed before the key exists.
machineRouter.use((req, res, next) => {
  const current = plane;
  if (current === null) {
    next();
    return;
  }
  machineAuthMiddleware({
    key: current.key,
    allowWrite: current.grants.write,
  })(req, res, next);
});

// Bodies are parsed AFTER the gate ladder, deliberately. An unauthenticated
// caller should never reach a parser: JSON parsing is attack surface, and
// spending it on a request that gate 1 or gate 3 is about to refuse is work
// done on behalf of someone we are refusing to talk to.
machineRouter.use(express.json({ limit: MAX_BODY_BYTES }));

/**
 * Turn a route definition into an Express handler: gate 4, gate 5, then run.
 *
 * A throw becomes an envelope rather than Express's default HTML error page,
 * which would be an unparseable surprise for both callers.
 */
function handlerFor(def: AnyRouteDef) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    const current = plane;

    try {
      if (current === null) {
        throw new MachineError('not_found', 'Not found.');
      }

      // Gate 4 — tier.
      assertTier(def.tier, current.grants);

      // Gate 5 — input. Query for reads, body for everything else; a route
      // never reads both, so a caller cannot get a different answer depending
      // on where they put the argument.
      const raw = def.method === 'GET' ? req.query : req.body;
      const args = def.validate(raw, def.method === 'GET' ? 'query' : 'body');

      // The engine, only for the routes that actually need it — so the
      // diagnostic routes keep answering when it is broken (§8.0).
      if (def.needsEngine) {
        await requireEngine(current.env);
      }

      const { data, meta } = await def.run({
        args,
        req: req as MachineRequest,
        res,
        grants: current.grants,
        keyFingerprint: fingerprint(current.key),
        serverVersion: SERVER_VERSION,
        env: current.env,
        routes: ROUTES,
        engine: () => engineState(current.env),
      });

      sendOk(res, data, {
        serverVersion: SERVER_VERSION,
        tookMs: Date.now() - startedAt,
        tier: def.tier,
        ...meta,
      });
    } catch (err) {
      sendError(res, toMachineError(err));
    }
  };
}

for (const def of ROUTES) {
  const method = def.method.toLowerCase() as
    | 'get'
    | 'post'
    | 'patch'
    | 'put'
    | 'delete';
  machineRouter[method](def.path, handlerFor(def));
}

/**
 * Terminal 404 — nothing under /machine/v1 escapes this router.
 *
 * Registered last, after every route. Without it an unrecognised path falls
 * through to app.ts's SPA catch-all and comes back as index.html with a 200,
 * so a mistyped route produces "answered 200 with no JSON body" — the same
 * misleading symptom as a mis-mounted plane, and it sends you hunting for a
 * port conflict instead of a typo. Everything on this plane answers in the
 * envelope, including "no such route".
 */
machineRouter.use((_req: Request, res: Response) => {
  res.status(404).json({
    ok: false,
    error: {
      code: 'not_found',
      message: 'No such machine-plane route.',
      hint: 'GET /machine/v1/capabilities for the route table',
    },
  });
});

/**
 * Resolve (minting if absent) the machine key and arm the router.
 *
 * Called from run(), never at import. Returns null when no key could be
 * resolved, in which case the plane stays 404 — fail closed.
 */
export function initMachinePlane(
  env: NodeJS.ProcessEnv = process.env,
): MachinePlaneInfo | null {
  const resolved = resolveMachineKey({
    env,
    mint: true,
    mintedBy: 'sync-server',
  });

  if (!resolved) {
    return null;
  }

  const grants = grantsFromEnv(env);
  plane = { key: resolved.key, grants, env };

  return {
    keyFingerprint: fingerprint(resolved.key),
    allowWrite: grants.write,
    allowAdmin: grants.admin,
    routeCount: ROUTES.length,
  };
}

/** Release the engine on the way out, so the budget's database closes cleanly. */
export async function stopMachinePlane(): Promise<void> {
  await shutdownEngine();
}

/** Test seam: forget the key so a test can assert the fail-closed path. */
export function resetMachinePlaneForTests(): void {
  plane = null;
}
