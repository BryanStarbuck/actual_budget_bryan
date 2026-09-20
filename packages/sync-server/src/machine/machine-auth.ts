/**
 * The machine plane's gate ladder — pm/cli.mdx §4.4 and §4.4a.
 *
 * Order is load-bearing: loopback, then origin, then key, then mode, then the
 * route's own input schema. Nothing below a gate runs until it passes.
 *
 * Two facts about the app this mounts inside shape every line here:
 *
 *   1. `app.set('trust proxy', …)` is global (app.ts), so `req.ip` is derived
 *      from X-Forwarded-For and is attacker-controlled. We read
 *      `req.socket.remoteAddress` — the kernel's view of the peer — and never
 *      consult req.ip, req.ips, X-Forwarded-For or X-Real-IP.
 *
 *   2. `app.use(cors())` is global and permissive, so "arrived on loopback"
 *      includes any web page the operator happens to have open. A page at
 *      https://evil.example can fetch 127.0.0.1:5006 and the packet really
 *      does come from the loopback interface. The key is what stops it — and
 *      the origin gate below is the second wall so that is not one control
 *      deep.
 */
import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

/** Every refusal on this plane is a 404. Off this machine, it does not exist. */
function notFound(res: Response): void {
  res.status(404).json({
    ok: false,
    error: { code: 'not_found', message: 'Not found.' },
  });
}

/**
 * A constant 401 body (§4.4). It never distinguishes a missing key from a
 * wrong one: the server keeps its silence and the CLI does the explaining,
 * because the CLI knows which file it failed to read and the server does not
 * know who is asking.
 */
function unauthorized(res: Response): void {
  res.status(401).json({ ok: false, error: { code: 'unauthorized' } });
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The only address check on this plane.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what a dual-stack listener reports
 * for an IPv4 loopback client, so omitting it makes the plane unreachable on
 * exactly the machines it is meant for.
 */
export function isLoopbackSocket(req: Request): boolean {
  const address = req.socket.remoteAddress;
  if (!address) {
    // No peer address means we cannot prove it is local, so it is not.
    return false;
  }
  if (LOOPBACK_ADDRESSES.has(address)) {
    return true;
  }
  // 127.0.0.0/8 is all loopback, not just .0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address);
}

/** Our own dev UI, the only origin that may ever be answered. */
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
]);

const ALLOWED_HOSTS = new Set([
  '127.0.0.1:5006',
  'localhost:5006',
  '[::1]:5006',
]);

/**
 * Is this a browser? (§4.4a)
 *
 * `abx`, the MCP and curl send no Origin and no Sec-Fetch-Site. A browser
 * always sends at least one and cannot be talked out of it, so the header's
 * presence is the signal — we do not need to recognise the attacker's origin,
 * only that there is one.
 */
export function isBrowserOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    return true;
  }

  const site = req.get('sec-fetch-site');
  if (site !== undefined && site !== 'none' && site !== 'same-origin') {
    return true;
  }

  return false;
}

/**
 * DNS rebinding turns a remote page into a loopback client, and the Host
 * header is what it has to lie about to get there.
 */
export function isAllowedHost(req: Request): boolean {
  const host = req.get('host');
  if (host === undefined) {
    return false;
  }
  if (ALLOWED_HOSTS.has(host)) {
    return true;
  }
  // Tolerate a non-default port on the same loopback names (a second checkout).
  return /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|\[::1\])(:\d+)?$/.test(
    host,
  );
}

/**
 * Constant-time comparison that is safe on unequal lengths (§4.4).
 *
 * `timingSafeEqual` THROWS on a length mismatch, so the obvious guard —
 * `a.length === b.length && timingSafeEqual(a, b)` — leaks the length through
 * timing and is itself an oracle. We always run one fixed-length comparison
 * against a digest of each side, so the work done is identical whatever
 * arrives.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

export const MACHINE_KEY_HEADER = 'x-actual-machine-key';

export type MachineAuthOptions = {
  /** The key this server holds. Absent means the plane is not mounted (R9). */
  key: string;
  /** Write routes answer only when this is true (§5.2). */
  allowWrite: boolean;
};

export type MachineRequest = Request & {
  machine: { allowWrite: boolean };
};

export function machineAuthMiddleware({ key, allowWrite }: MachineAuthOptions) {
  return function machineAuth(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    // Undo the app-wide `cors()` for this plane.
    //
    // app.ts calls `app.use(cors())` with no options, which reflects any
    // origin — so by the time we run, `Access-Control-Allow-Origin: *` is
    // already on the response. The origin gate below means no browser gets an
    // answer anyway, but advertising a permissive CORS policy on a surface
    // that holds the operator's ledger is the kind of header that turns into
    // a finding in a review, and into a real hole the day someone adds a
    // route that answers before this middleware.
    res.removeHeader('Access-Control-Allow-Origin');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.removeHeader('Access-Control-Expose-Headers');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');

    // Gate 1 — loopback. Other computers.
    if (!isLoopbackSocket(req)) {
      notFound(res);
      return;
    }

    // Gate 2 — origin. Other origins on this computer.
    if (isBrowserOrigin(req) || !isAllowedHost(req)) {
      notFound(res);
      return;
    }

    // Gate 3 — the key. Other users on this computer.
    const presented = req.get(MACHINE_KEY_HEADER);
    if (presented === undefined || !constantTimeEquals(presented, key)) {
      unauthorized(res);
      return;
    }

    (req as MachineRequest).machine = { allowWrite };
    next();
  };
}
