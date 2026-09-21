/**
 * The plane's own routes — pm/apis.mdx §8.0.
 *
 * These four answer WITHOUT an initialised engine, and that is the design
 * rather than an accident: their job is to tell a caller what is wrong, and a
 * diagnostic route that needs the thing it is diagnosing is no diagnostic at
 * all.
 *
 * The distinction between them is the one that decides where an operator
 * looks first, so it is worth stating once:
 *
 *   /ping          the plane is mounted and your key is right
 *   /whoami        …and here is which install, which budget, which tiers
 *   /capabilities  …and here is exactly what this build can do
 *   /health        …and here is whether it can actually answer a question
 *
 * A green upstream /health with a 401 from /ping is the commonest first-run
 * failure there is, and the two have to be distinguishable (§8.0).
 */
import type { engineState } from '#machine/engine';
import { knownBudgets, requireEngine } from '#machine/engine';
import { describeRoutes, route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { TIERS } from '#machine/tier';
import { fields, takesNothing } from '#machine/validate';

/** Published in /capabilities so a client can branch on a build, not a 404. */
export const FEATURES: readonly string[] = ['plane'];

export const MAX_LIMIT = 5000;
export const MAX_CHANGES_DEFAULT = 200;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export const planeRoutes: AnyRouteDef[] = [
  route({
    method: 'GET',
    path: '/ping',
    tier: 'read',
    summary: 'Liveness, key check, server version and write tier.',
    status: 'live',
    needsEngine: false,
    validate: takesNothing(),
    run: async ctx => ({
      data: {
        ok: true,
        writeTier: ctx.grants.write,
        adminTier: ctx.grants.admin,
        keyFingerprint: ctx.keyFingerprint,
        serverVersion: ctx.serverVersion,
      },
    }),
  }),

  route({
    method: 'GET',
    path: '/whoami',
    tier: 'read',
    summary: 'Which install, which budget, which tiers, which key.',
    status: 'live',
    needsEngine: false,
    validate: takesNothing(),
    run: async ctx => {
      const engine = ctx.engine();
      return {
        data: {
          target: 'local',
          serverVersion: ctx.serverVersion,
          keyFingerprint: ctx.keyFingerprint,
          tiers: {
            read: true,
            write: ctx.grants.write,
            // Reported, and reported as false on every machine that has not
            // deliberately turned it on, so "can this thing delete my data"
            // is answerable in one call.
            admin: ctx.grants.admin,
          },
          engine: {
            status: engine.status,
            dataDir: engine.dataDir,
            ...(engine.error !== undefined ? { error: engine.error } : {}),
            ...(engine.hint !== undefined ? { hint: engine.hint } : {}),
          },
          budget: engine.budget,
          // Configured, or null. NEVER the operator's real path baked in
          // anywhere — it is configuration, and this repo is public
          // (apis.mdx §17).
          statementsRoot: ctx.env.ABX_STATEMENTS_DIR ?? null,
        },
        meta:
          engine.budget !== null
            ? { budgetId: engine.budget.id, budgetName: engine.budget.name }
            : {},
      };
    },
  }),

  route({
    method: 'GET',
    path: '/capabilities',
    tier: 'read',
    summary: 'The route table, tiers, limits and features of THIS build.',
    status: 'live',
    needsEngine: false,
    validate: takesNothing(),
    run: async ctx => {
      const engine = ctx.engine();
      return {
        data: {
          apiVersion: 'v1',
          serverVersion: ctx.serverVersion,
          tiers: {
            read: true,
            write: ctx.grants.write,
            admin: ctx.grants.admin,
          },
          budgetLoaded: engine.budget !== null,
          // Generated from the same array the router is built from. A route
          // here that the router does not serve is impossible by
          // construction, which is the whole point (§6.3).
          routes: describeRoutes(ctx.routes),
          limits: {
            maxLimit: MAX_LIMIT,
            maxChangesDefault: MAX_CHANGES_DEFAULT,
            maxBodyBytes: MAX_BODY_BYTES,
          },
          features: FEATURES,
          knownTiers: TIERS,
        },
      };
    },
  }),

  route({
    method: 'GET',
    path: '/health',
    tier: 'read',
    summary:
      'Can this plane actually answer a question about a budget? probe=true starts the engine.',
    status: 'live',
    needsEngine: false,
    validate: fields<{ probe?: boolean }>({ probe: { type: 'boolean' } }),
    run: async ctx => {
      // `probe` exists because the engine is lazy, and a diagnostic that can
      // only report "not started yet" is not much of a diagnostic. Without it
      // the only way to find out whether the engine WOULD start is to call a
      // real budget route and read the failure, which is a poor thing to ask
      // of somebody whose install is already not working.
      //
      // It defaults to false so the ordinary health check stays free of the
      // dependency it is reporting on (§8.0), and a failed probe is reported
      // rather than thrown — this route answers 200 with bad news.
      if (ctx.args.probe === true) {
        try {
          await requireEngine(ctx.env);
        } catch {
          // engineState() below carries the reason and the remediation.
        }
      }

      const engine = ctx.engine();
      const budgets = await knownBudgets();

      // `healthy` is deliberately narrow: an engine that is up with no budget
      // open is NOT healthy for the purpose a caller has in mind, and saying
      // "ok" there is how a model concludes an empty answer means no
      // transactions rather than no budget.
      const healthy = engine.status === 'ready' && engine.budget !== null;

      return {
        data: {
          healthy,
          engine: {
            status: engine.status,
            dataDir: engine.dataDir,
            ...(engine.error !== undefined ? { error: engine.error } : {}),
          },
          budget: engine.budget,
          knownBudgets: budgets,
          hint: healthy ? null : unhealthyHint(engine, budgets.length, ctx.env),
        },
        meta:
          engine.budget !== null
            ? { budgetId: engine.budget.id, budgetName: engine.budget.name }
            : {},
      };
    },
  }),
];

/**
 * One sentence naming the next action, for each way this can be unhealthy.
 *
 * Every branch is a real state somebody will hit on a first run, and a generic
 * "not ready" would send all four of them to the same wrong place (§5.4).
 */
function unhealthyHint(
  engine: ReturnType<typeof engineState>,
  budgetCount: number,
  env: NodeJS.ProcessEnv,
): string {
  if (engine.status === 'unavailable') {
    // The engine distinguishes "absent" from "present but unbuilt"; pass its
    // own remediation through rather than guessing at a generic one.
    return engine.hint ?? 'the budget engine is not available here';
  }
  if (engine.status === 'failed') {
    return (
      engine.hint ??
      `check that ${engine.dataDir} is writable, then restart the sync server`
    );
  }
  if (engine.status === 'idle') {
    return 'the engine has not been started yet — GET /machine/v1/health?probe=true to start it and report the result';
  }
  if (engine.status === 'starting') {
    return 'the engine is starting — retry in a moment';
  }
  if (budgetCount === 0) {
    return `no budget files found in ${engine.dataDir} — download or create one first`;
  }
  if (env.ACTUAL_MACHINE_BUDGET_ID === undefined && budgetCount > 1) {
    return 'more than one budget exists and none is configured — set ACTUAL_MACHINE_BUDGET_ID (see knownBudgets above)';
  }
  return 'the configured budget could not be opened — check ACTUAL_MACHINE_BUDGET_ID against knownBudgets above';
}
