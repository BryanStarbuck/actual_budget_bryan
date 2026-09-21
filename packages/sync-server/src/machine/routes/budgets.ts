/**
 * Budget files and sync — pm/apis.mdx §8.1.
 *
 * `POST /budgets/:id/load` is the one route with global side effects: every
 * other route's `meta.budgetId` changes underneath the caller. It requires a
 * confirm token like any write, and the token's fingerprint covers the target.
 *
 * `POST /sync` has no dry run — there is nothing to preview — and it is what
 * moves the engine's writes to the sync server, and from there to the browser
 * and the operator's phone. The import routes call it themselves after an
 * apply when the engine is connected, and say so in their response.
 */
import { fingerprintOf, issueConfirm, redeemConfirm } from '#machine/confirm';
import type { KnownBudget } from '#machine/engine';
import {
  engineState,
  knownBudgets,
  markBudgetOpen,
  openKnownBudget,
  requireBudget,
  requireEngine,
} from '#machine/engine';
import { MachineError } from '#machine/envelope';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { fields, takesNothing } from '#machine/validate';

type CreateArgs = {
  name: string;
  dry_run?: boolean;
  confirm_token?: string;
};

type LoadArgs = {
  id: string;
  dry_run?: boolean;
  confirm_token?: string;
};

async function findBudget(id: string): Promise<KnownBudget> {
  const all = await knownBudgets();
  const found = all.find(b => b.id === id || b.cloudFileId === id);
  if (!found) {
    throw new MachineError(
      'not_found',
      `No budget with id ${id}.`,
      all.length === 0
        ? 'no budgets exist — POST /budgets to create one'
        : `known budgets: ${all.map(b => `${b.id} (${b.name}, ${b.where})`).join(', ')}`,
    );
  }
  return found;
}

/** Sync if connected. Never throws — a failed sync is reported, not fatal, because the write already happened. */
export async function syncIfConnected(
  env: NodeJS.ProcessEnv,
): Promise<{ synced: boolean; error?: string }> {
  const state = engineState(env);
  if (!state.server.connected) {
    return { synced: false, error: 'the engine is not connected to the sync server' };
  }
  try {
    const { lib } = await requireBudget(env);
    await lib.send('api/sync');
    return { synced: true };
  } catch (err) {
    return { synced: false, error: (err as Error).message };
  }
}

export const budgetRoutes: AnyRouteDef[] = [
  route<Record<string, never>>({
    method: 'GET',
    path: '/budgets',
    tier: 'read',
    summary:
      'The budgets this install knows: on disk here, on the sync server, or both; and which one is open.',
    status: 'live',
    needsEngine: true,
    validate: takesNothing(),
    run: async ctx => {
      const state = ctx.engine();
      const budgets = await knownBudgets();
      return {
        data: {
          budgets,
          open: state.budget,
          server: state.server,
        },
        meta: state.budget
          ? { budgetId: state.budget.id, budgetName: state.budget.name }
          : {},
      };
    },
  }),

  route<CreateArgs>({
    method: 'POST',
    path: '/budgets',
    tier: 'write',
    summary:
      'Create a new, empty budget, open it, and upload it to the sync server so the browser can see it. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<CreateArgs>({
      name: { type: 'string', required: true, maxLength: 120 },
      dry_run: { type: 'boolean' },
      confirm_token: { type: 'string' },
    }),
    run: async ctx => {
      const { name, dry_run = true, confirm_token } = ctx.args;
      const lib = await requireEngine(ctx.env);
      const state = ctx.engine();
      const existing = await knownBudgets();
      if (existing.some(b => b.name === name)) {
        throw new MachineError(
          'conflict',
          `A budget named "${name}" already exists.`,
          'load it with POST /budgets/{id}/load, or choose another name',
        );
      }

      const plan = {
        create: { name, uploaded_to_sync_server: state.server.connected },
      };
      const fp = fingerprintOf(plan);
      if (dry_run) {
        return { data: { dry_run: true, ...plan, ...issueConfirm('budget.create', fp) } };
      }
      redeemConfirm(confirm_token as string, 'budget.create', fp, plan);

      const result = (await lib.send('create-budget', { budgetName: name })) as {
        error?: string;
      };
      if (result?.error) {
        throw new MachineError(
          'upstream_error',
          `The app refused to create the budget (${result.error}).`,
          'read ~/T/actual_budget/error.err',
        );
      }
      const created = (await knownBudgets()).find(b => b.name === name);
      if (!created) {
        throw new MachineError('internal', 'The budget was created but cannot be found.');
      }
      markBudgetOpen(created.id, created.name);
      return {
        data: {
          dry_run: false,
          id: created.id,
          name: created.name,
          where: created.where,
          open: true,
        },
        meta: { budgetId: created.id, budgetName: created.name },
      };
    },
  }),

  route<LoadArgs>({
    method: 'POST',
    path: '/budgets/:id/load',
    tier: 'write',
    summary:
      'Open a different budget, downloading it from the sync server first if it only exists there. Changes what every other route answers about. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<LoadArgs>({
      dry_run: { type: 'boolean' },
      confirm_token: { type: 'string' },
    }),
    run: async ctx => {
      const id = ctx.req.params.id;
      const { dry_run = true, confirm_token } = ctx.args;
      await requireEngine(ctx.env);
      const target = await findBudget(id);
      const plan = { load: { id: target.id, name: target.name, where: target.where } };
      const fp = fingerprintOf(plan);
      if (dry_run) {
        return { data: { dry_run: true, ...plan, ...issueConfirm('budget.load', fp) } };
      }
      redeemConfirm(confirm_token as string, 'budget.load', fp, plan);
      await openKnownBudget(target);
      const state = ctx.engine();
      return {
        data: { dry_run: false, open: state.budget },
        meta: state.budget
          ? { budgetId: state.budget.id, budgetName: state.budget.name }
          : {},
      };
    },
  }),

  route<Record<string, never>>({
    method: 'POST',
    path: '/sync',
    tier: 'write',
    summary:
      "Push the open budget's changes to the sync server and pull everyone else's. No dry run.",
    status: 'live',
    needsEngine: true,
    validate: takesNothing(),
    run: async ctx => {
      const { budget } = await requireBudget(ctx.env);
      const result = await syncIfConnected(ctx.env);
      if (!result.synced) {
        throw new MachineError(
          'upstream_error',
          `Sync failed: ${result.error ?? 'unknown reason'}.`,
          'check that the sync server is bootstrapped and reachable, then retry',
        );
      }
      return {
        data: { synced: true, budget },
        meta: { budgetId: budget.id, budgetName: budget.name },
      };
    },
  }),
];
