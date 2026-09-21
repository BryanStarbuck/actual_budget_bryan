/**
 * The read verbs — pm/cli.mdx §8, over pm/apis.mdx §8.1–§8.3 and §11.
 *
 * Each verb is one machine-plane call whose answer is printed as-is. Money is
 * integer cents on the wire and is formatted by centsToDecimal only, never by
 * float division. Totals are the app's own figures (balance_current from the
 * engine), never a sum computed here.
 */
import { getBoolean, getNumber, getString, requireString } from '../args.js';
import { call } from '../client.js';
import { out, render } from '../render.js';
import type { Row } from '../render.js';
import type { Context, Verb } from '../verb.js';

type Account = {
  id: string;
  name: string;
  offbudget: boolean;
  closed: boolean;
  balance_current: number;
};

type Transaction = {
  id: string;
  date: string;
  amount: number;
  payee?: string | null;
  imported_payee?: string | null;
  notes?: string | null;
  imported_id?: string | null;
  cleared?: boolean;
};

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const budgets: Verb = {
  name: 'budgets',
  summary: 'the budgets this install knows, and which one is open',
  async run(ctx: Context): Promise<number> {
    const envelope = await call(ctx.target, ctx.requireKey(), '/budgets', {
      timeoutMs: 30_000,
      logger: ctx.logger,
      verb: 'budgets',
    });
    const d = (envelope as { data: { budgets: Array<{ id: string; name: string; where: string }>; open: { id: string } | null } }).data;
    const rows: Row[] = d.budgets.map(b => ({
      open: d.open?.id === b.id ? '*' : '',
      name: b.name,
      where: b.where,
      id: b.id,
    }));
    out(
      render(ctx.format, envelope, rows, [
        { key: 'open', header: '' },
        { key: 'name', header: 'BUDGET' },
        { key: 'where', header: 'WHERE' },
        { key: 'id', header: 'ID' },
      ]),
    );
    return 0;
  },
};

export const accountsList: Verb = {
  name: 'accounts list',
  summary: 'every account with the app\'s own balance',
  flags: {
    'include-closed': { arity: 'boolean', help: 'include closed accounts' },
  },
  async run(ctx: Context): Promise<number> {
    const includeClosed = getBoolean(ctx.args, 'include-closed');
    const envelope = await call(
      ctx.target,
      ctx.requireKey(),
      `/accounts${query({ include_closed: includeClosed ? 'true' : undefined })}`,
      { timeoutMs: 60_000, logger: ctx.logger, verb: 'accounts list' },
    );
    const accounts = (envelope as { data: Account[] }).data;
    const rows: Row[] = accounts.map(a => ({
      name: a.name,
      budget: a.offbudget ? 'off' : 'on',
      balance: a.balance_current,
      id: a.id,
    }));
    out(
      render(ctx.format, envelope, rows, [
        { key: 'name', header: 'ACCOUNT' },
        { key: 'budget', header: 'BUDGET' },
        { key: 'balance', header: 'BALANCE', align: 'right', money: true },
        { key: 'id', header: 'ID' },
      ]),
    );
    return 0;
  },
};

export const accountsBalance: Verb = {
  name: 'accounts balance',
  summary: 'one account\'s balance, optionally as of a date',
  positionals: ['<id>'],
  flags: {
    'as-of': { arity: 'date', help: 'balance as of the end of this date (YYYY-MM-DD)' },
  },
  async run(ctx: Context): Promise<number> {
    const id = ctx.args.positionals[0];
    if (!id) {
      throw new Error('abx accounts balance <id> — the account id is required (abx accounts list shows them)');
    }
    const envelope = await call(
      ctx.target,
      ctx.requireKey(),
      `/accounts/${encodeURIComponent(id)}/balance${query({ as_of: getString(ctx.args, 'as-of') })}`,
      { timeoutMs: 30_000, logger: ctx.logger, verb: 'accounts balance' },
    );
    const d = (envelope as { data: { name: string; balance: number; as_of: string | null } }).data;
    out(
      render(ctx.format, envelope, [{ name: d.name, as_of: d.as_of ?? 'now', balance: d.balance }], [
        { key: 'name', header: 'ACCOUNT' },
        { key: 'as_of', header: 'AS OF' },
        { key: 'balance', header: 'BALANCE', align: 'right', money: true },
      ]),
    );
    return 0;
  },
};

export const transactionsList: Verb = {
  name: 'transactions list',
  summary: 'transactions for one account, newest first',
  flags: {
    account: { arity: 'string', help: 'the account id (required)' },
    start: { arity: 'date', help: 'earliest date, YYYY-MM-DD' },
    end: { arity: 'date', help: 'latest date, YYYY-MM-DD' },
    limit: { arity: 'number', help: 'rows to return (default 50, cap 5000)' },
  },
  async run(ctx: Context): Promise<number> {
    const account = requireString(ctx.args, 'account');
    const envelope = await call(
      ctx.target,
      ctx.requireKey(),
      `/transactions${query({
        account_id: account,
        start: getString(ctx.args, 'start'),
        end: getString(ctx.args, 'end'),
        limit: getNumber(ctx.args, 'limit') ?? 50,
      })}`,
      { timeoutMs: 60_000, logger: ctx.logger, verb: 'transactions list' },
    );
    const txns = (envelope as { data: Transaction[] }).data;
    const rows: Row[] = txns.map(t => ({
      date: t.date,
      amount: t.amount,
      payee: t.imported_payee ?? '',
      notes: t.notes ?? '',
    }));
    out(
      render(ctx.format, envelope, rows, [
        { key: 'date', header: 'DATE' },
        { key: 'amount', header: 'AMOUNT', align: 'right', money: true },
        { key: 'payee', header: 'PAYEE' },
        { key: 'notes', header: 'NOTES' },
      ]),
    );
    return 0;
  },
};

export const statementsManifest: Verb = {
  name: 'statements manifest',
  summary: 'the statement archive\'s manifest: one row per account and its file to import',
  async run(ctx: Context): Promise<number> {
    const envelope = await call(ctx.target, ctx.requireKey(), '/ingest/manifest', {
      timeoutMs: 30_000,
      logger: ctx.logger,
      verb: 'statements manifest',
    });
    const d = (envelope as { data: { accounts: Array<Record<string, string>> } }).data;
    const rows: Row[] = d.accounts.map(a => ({
      institution: a.institution,
      type: a.type,
      group: a.import_group,
      mode: a.mode,
      statements: a.statements,
      rows: a.transactions,
      span: `${a.first}..${a.last}`,
    }));
    out(
      render(ctx.format, envelope, rows, [
        { key: 'institution', header: 'INSTITUTION' },
        { key: 'type', header: 'ACCOUNT' },
        { key: 'group', header: 'GROUP' },
        { key: 'mode', header: 'MODE' },
        { key: 'statements', header: 'STMTS', align: 'right' },
        { key: 'rows', header: 'ROWS', align: 'right' },
        { key: 'span', header: 'SPAN' },
      ]),
    );
    return 0;
  },
};
