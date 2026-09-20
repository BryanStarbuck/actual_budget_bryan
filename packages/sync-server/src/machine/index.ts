/**
 * The machine plane — pm/cli.mdx §5.
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
 */
import express from 'express';
import type { Request, Response } from 'express';

import { fingerprint, resolveMachineKey } from './credentials-file.js';
import { MachineError, sendError, sendOk, toMachineError } from './envelope.js';
import { machineAuthMiddleware } from './machine-auth.js';
import type { MachineRequest } from './machine-auth.js';

export type MachinePlaneInfo = {
  keyFingerprint: string;
  allowWrite: boolean;
};

/** Set once, by initMachinePlane(). Null means "not mounted" to every request. */
let plane: { key: string; allowWrite: boolean } | null = null;

const SERVER_VERSION = process.env.npm_package_version ?? 'unknown';

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
    allowWrite: current.allowWrite,
  })(req, res, next);
});

/**
 * Wrap a handler so a throw becomes an envelope rather than Express's default
 * HTML error page — which would be an unparseable surprise for both callers.
 */
function handle(
  fn: (req: MachineRequest) => Promise<{ data: unknown; meta?: object }>,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const startedAt = Date.now();
    try {
      const { data, meta } = await fn(req as MachineRequest);
      sendOk(res, data, {
        serverVersion: SERVER_VERSION,
        tookMs: Date.now() - startedAt,
        ...meta,
      });
    } catch (err) {
      sendError(res, toMachineError(err));
    }
  };
}

/** Write routes need the server's tier AND the caller's --write (§5.2). */
function requireWriteTier(req: MachineRequest): void {
  if (!req.machine.allowWrite) {
    throw new MachineError(
      'write_disabled',
      'The write tier is off on this server.',
      'start the sync server with ACTUAL_MACHINE_ALLOW_WRITE=1',
    );
  }
}

/**
 * /health proves the process is alive; ping proves the plane is mounted and
 * the key is right. A green /health with a 401 from ping is the single most
 * likely first-run failure, and it needs to be distinguishable (§3.2).
 */
machineRouter.get(
  '/ping',
  handle(async req => ({
    data: {
      ok: true,
      writeTier: req.machine.allowWrite,
      keyFingerprint: fingerprint(plane?.key ?? ''),
      serverVersion: SERVER_VERSION,
    },
  })),
);

machineRouter.post(
  '/sync',
  handle(async req => {
    requireWriteTier(req);
    throw new MachineError(
      'not_ready',
      'Budget routes are not wired up yet.',
      'see pm/cli.mdx §21 — build phase P4',
    );
  }),
);

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
      hint: 'see pm/cli.mdx §5.2 for the route table',
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

  plane = {
    key: resolved.key,
    allowWrite: env.ACTUAL_MACHINE_ALLOW_WRITE === '1',
  };

  return {
    keyFingerprint: fingerprint(resolved.key),
    allowWrite: plane.allowWrite,
  };
}

/** Test seam: forget the key so a test can assert the fail-closed path. */
export function resetMachinePlaneForTests(): void {
  plane = null;
}
