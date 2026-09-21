/**
 * Accounts — pm/apis.mdx §8.2 (the subset an import needs).
 *
 * `data` is the engine's own casing (`offbudget`, `balance_current`), verbatim
 * (§5.1a). Balances come from the engine's `account-balance`, never from
 * summing rows here (§2 R7).
 *
 * The account model has no type field — import_formats.mdx §9. A card is an
 * on-budget account whose balance runs negative; a brokerage is off-budget.
 * `POST /accounts` takes `offbudget` and nothing else about kind.
 */
import { fingerprintOf, issueConfirm, redeemConfirm } from '#machine/confirm';
import { requireBudget } from '#machine/engine';
import { MachineError } from '#machine/envelope';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { fields } from '#machine/validate';

type ApiAccount = {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  account_group_id?: string | null;
};

type ListArgs = { include_closed?: boolean; with_balances?: boolean };
type BalanceArgs = { as_of?: string };
type CreateArgs = {
  name: string;
  offbudget?: boolean;
  initial_balance?: number;
  dry_run?: boolean;
  confirm_token?: string;
};

async function listAccounts(
  env: NodeJS.ProcessEnv,
): Promise<{ accounts: ApiAccount[]; budget: { id: string; name: string } }> {
  const { lib, budget } = await requireBudget(env);
  const accounts = (await lib.send('api/accounts-get')) as ApiAccount[];
  return { accounts, budget };
}

async function withBalances(
  lib: { send: (name: string, args?: unknown) => Promise<unknown> },
  accounts: ApiAccount[],
  cutoff?: Date,
): Promise<Array<ApiAccount & { balance_current: number }>> {
  const out = [];
  for (const account of accounts) {
    const balance = (await lib.send('api/account-balance', {
      id: account.id,
      ...(cutoff ? { cutoff } : {}),
    })) as number;
    out.push({ ...account, balance_current: balance });
  }
  return out;
}

export const accountRoutes: AnyRouteDef[] = [
  route<ListArgs>({
    method: 'GET',
    path: '/accounts',
    tier: 'read',
    summary:
      'Every account with its current balance in integer cents. Closed accounts excluded unless include_closed.',
    status: 'live',
    needsEngine: true,
    validate: fields<ListArgs>({
      include_closed: { type: 'boolean' },
      with_balances: { type: 'boolean' },
    }),
    run: async ctx => {
      const { include_closed = false, with_balances = true } = ctx.args;
      const { lib } = await requireBudget(ctx.env);
      const { accounts, budget } = await listAccounts(ctx.env);
      const visible = include_closed ? accounts : accounts.filter(a => !a.closed);
      const data = with_balances ? await withBalances(lib, visible) : visible;
      return { data, meta: { budgetId: budget.id, budgetName: budget.name } };
    },
  }),

  route<Record<string, never>>({
    method: 'GET',
    path: '/accounts/:id',
    tier: 'read',
    summary: 'One account by id, with its current balance in integer cents.',
    status: 'live',
    needsEngine: true,
    validate: fields<Record<string, never>>({}),
    run: async ctx => {
      const { lib } = await requireBudget(ctx.env);
      const { accounts, budget } = await listAccounts(ctx.env);
      const found = accounts.find(a => a.id === ctx.req.params.id);
      if (!found) {
        throw new MachineError(
          'not_found',
          `No account with id ${ctx.req.params.id}.`,
          'GET /accounts lists the ids',
        );
      }
      const [data] = await withBalances(lib, [found]);
      return { data, meta: { budgetId: budget.id, budgetName: budget.name } };
    },
  }),

  route<BalanceArgs>({
    method: 'GET',
    path: '/accounts/:id/balance',
    tier: 'read',
    summary:
      "One account's balance in integer cents, optionally as of the end of a date.",
    status: 'live',
    needsEngine: true,
    validate: fields<BalanceArgs>({ as_of: { type: 'string', maxLength: 10 } }),
    run: async ctx => {
      const { lib } = await requireBudget(ctx.env);
      const { accounts, budget } = await listAccounts(ctx.env);
      const found = accounts.find(a => a.id === ctx.req.params.id);
      if (!found) {
        throw new MachineError('not_found', `No account with id ${ctx.req.params.id}.`);
      }
      let cutoff: Date | undefined;
      if (ctx.args.as_of) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(ctx.args.as_of)) {
          throw new MachineError('invalid_input', 'as_of must be YYYY-MM-DD.');
        }
        cutoff = new Date(`${ctx.args.as_of}T23:59:59`);
      }
      const [data] = await withBalances(lib, [found], cutoff);
      return {
        data: { id: data.id, name: data.name, balance: data.balance_current, as_of: ctx.args.as_of ?? null },
        meta: { budgetId: budget.id, budgetName: budget.name },
      };
    },
  }),

  route<CreateArgs>({
    method: 'POST',
    path: '/accounts',
    tier: 'write',
    summary:
      'Create an account. offbudget defaults false; initial_balance is integer cents. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<CreateArgs>({
      name: { type: 'string', required: true, maxLength: 120 },
      offbudget: { type: 'boolean' },
      initial_balance: { type: 'integer' },
      dry_run: { type: 'boolean' },
      confirm_token: { type: 'string' },
    }),
    run: async ctx => {
      const {
        name,
        offbudget = false,
        initial_balance,
        dry_run = true,
        confirm_token,
      } = ctx.args;
      const { lib, budget } = await requireBudget(ctx.env);
      const { accounts } = await listAccounts(ctx.env);
      const clash = accounts.find(a => a.name.trim().toLowerCase() === name.trim().toLowerCase());
      if (clash) {
        throw new MachineError(
          'conflict',
          `An account named "${clash.name}" already exists (id ${clash.id}).`,
          'use that id, or choose a different name',
        );
      }

      const plan = {
        create: { name, offbudget, initial_balance: initial_balance ?? null },
      };
      const fp = fingerprintOf(plan);
      if (dry_run) {
        return {
          data: { dry_run: true, ...plan, ...issueConfirm('account.create', fp) },
          meta: { budgetId: budget.id, budgetName: budget.name },
        };
      }
      redeemConfirm(confirm_token as string, 'account.create', fp, plan);

      const id = (await lib.send('api/account-create', {
        account: { name, offbudget, closed: false },
        initialBalance: initial_balance ?? null,
      })) as string;
      return {
        data: { dry_run: false, id, name, offbudget },
        meta: { budgetId: budget.id, budgetName: budget.name },
      };
    },
  }),
];
