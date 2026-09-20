/**
 * Routes that are declared but not yet implemented — pm/apis.mdx §21.
 *
 * A planned route is mounted, tiered and gated exactly like a live one, and
 * its handler refuses with `not_ready` naming the phase that will build it.
 *
 * WHY DECLARE THEM AT ALL, rather than adding each route when its phase
 * arrives: the gate ladder in front of a route is the part most worth testing
 * and the part least likely to change, and gate 4's write and admin branches
 * cannot be integration-tested through a real route until a phase that has
 * one. Declaring `POST /sync` here means the write-tier refusal is exercised
 * end to end — through the real router, the real auth middleware and the real
 * envelope — from P0 onwards instead of from P3.
 *
 * `/capabilities` publishes `status: "planned"` for each, so nothing here can
 * mislead a client into thinking it works (§6.3).
 */
import { MachineError } from '#machine/envelope';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { takesNothing } from '#machine/validate';

function notYet(phase: string): never {
  throw new MachineError(
    'not_ready',
    'This route is declared but not implemented yet.',
    `see pm/apis.mdx §21 — build phase ${phase}`,
  );
}

export const plannedRoutes: AnyRouteDef[] = [
  route({
    method: 'POST',
    path: '/sync',
    tier: 'write',
    summary: 'Sync with the sync server. NOT IMPLEMENTED YET (phase P3).',
    status: 'planned',
    needsEngine: false,
    validate: takesNothing(),
    run: async () => notYet('P3'),
  }),
];
