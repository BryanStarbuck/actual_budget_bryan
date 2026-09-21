/**
 * P2/P3/P4 — accounts, the JSON import door, and the file import door,
 * through the real router with a fake engine.
 *
 * pm/apis.mdx §7.1 (the switches), §7.2 (dry_run defaults true), §7.3 (the
 * token), §8.2, §8.3, §11.4, §11.7 (pinned options);
 * pm/import_formats.mdx §7 (the JSON contract), §11.1 (OFX in, CSV refused).
 *
 * The fake engine records every `send` so a test can assert the exact
 * importer call — in particular that a dry run passes `isPreview: true` and
 * that `reimportDeleted` is pinned false unless a caller says otherwise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetConfirmsForTests } from './confirm.js';
import { resetEngineForTests, setEngineForTests } from './engine.js';
import { MACHINE_KEY_HEADER } from './machine-auth.js';

import {
  initMachinePlane,
  machineRouter,
  resetMachinePlaneForTests,
} from './index.js';

let tmp: string;
const testApp = express();
testApp.use('/machine/v1', machineRouter);
const server = testApp.listen(0);

afterAll(() => {
  server.close();
});

type Call = { name: string; args: unknown };

/** A budget with one account and one existing transaction, id "existing-1". */
function fakeEngine(): { calls: Call[]; key: string } {
  const calls: Call[] = [];
  const accounts = [{ id: 'acct-1', name: 'Northbank Checking ••4021', offbudget: false, closed: false }];
  const ledger = new Set(['4021-20260203-4520-0-abcd1234']);

  const send = async (name: string, args?: unknown): Promise<unknown> => {
    calls.push({ name, args });
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'api/accounts-get':
        return accounts;
      case 'api/account-balance':
        return -1234;
      case 'api/account-create': {
        const acc = a.account as { name: string; offbudget: boolean };
        accounts.push({ id: 'acct-new', name: acc.name, offbudget: acc.offbudget, closed: false });
        return 'acct-new';
      }
      case 'api/transactions-import': {
        const rows = a.transactions as Array<{ imported_id?: string }>;
        const added = rows.filter(r => !r.imported_id || !ledger.has(r.imported_id));
        const matched = rows.filter(r => r.imported_id && ledger.has(r.imported_id));
        if (!a.isPreview) {
          for (const r of added) {
            if (r.imported_id) ledger.add(r.imported_id);
          }
        }
        return {
          errors: [],
          added: added.map((_, i) => `new-${i}`),
          updated: [],
          updatedPreview: matched.map(t => ({ transaction: t, ignored: true })),
        };
      }
      case 'transactions-parse-file': {
        const file = a.filepath as string;
        if (file.endsWith('bad.ofx')) {
          return { errors: [{ message: 'Invalid amount format: abc' }], transactions: [] };
        }
        return {
          errors: [],
          transactions: [
            { amount: -45.2, date: '2026-02-03', payee_name: 'Trader Joe', imported_payee: 'TRADER JOE', imported_id: '4021-20260203-4520-0-abcd1234', notes: null },
            { amount: 1200, date: '2026-02-05', payee_name: 'Payroll', imported_payee: 'PAYROLL', imported_id: '4021-20260205-120000-0-ffff0000', notes: 'Feb' },
          ],
        };
      }
      case 'api/sync':
        return undefined;
      default:
        return [];
    }
  };

  setEngineForTests({
    api: {
      init: async () => ({ send, getDataDir: () => tmp }),
      shutdown: async () => undefined,
      getBudgets: async () => [{ id: 'b1', name: 'Test Budget' }],
      loadBudget: async () => undefined,
    },
    lib: { send, getDataDir: () => tmp },
    budget: { id: 'b1', name: 'Test Budget' },
  });

  const key = crypto.randomBytes(32).toString('hex');
  const file = path.join(tmp, 'creds.json');
  fs.writeFileSync(file, JSON.stringify({ actual_budget: { machine: { api_key: key } } }), { mode: 0o600 });
  initMachinePlane({
    ABX_CREDENTIALS_FILE: file,
    ACTUAL_MACHINE_DATA_DIR: path.join(tmp, 'engine'),
    ACTUAL_MACHINE_ALLOW_WRITE: '1',
  });
  return { calls, key };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-import-'));
  resetMachinePlaneForTests();
  resetEngineForTests();
  resetConfirmsForTests();
});

afterEach(() => {
  resetMachinePlaneForTests();
  resetEngineForTests();
  resetConfirmsForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rows = [
  { date: '2026-02-03', amount: -4520, payee_name: 'Trader Joe', imported_id: '4021-20260203-4520-0-abcd1234' },
  { date: '2026-02-05', amount: 120000, payee_name: 'Payroll', imported_id: '4021-20260205-120000-0-ffff0000' },
];

describe('GET /accounts', () => {
  it('lists accounts with the engine balance, never a sum', async () => {
    const { key, calls } = fakeEngine();
    const res = await request(server).get('/machine/v1/accounts').set(MACHINE_KEY_HEADER, key);
    expect(res.status).toBe(200);
    expect(res.body.data[0].balance_current).toBe(-1234);
    expect(res.body.meta.budgetName).toBe('Test Budget');
    expect(calls.some(c => c.name === 'api/account-balance')).toBe(true);
  });
});

describe('POST /accounts', () => {
  it('dry-runs by default and creates only with the token', async () => {
    const { key, calls } = fakeEngine();
    const plan = await request(server)
      .post('/machine/v1/accounts')
      .set(MACHINE_KEY_HEADER, key)
      .send({ name: 'Fidelity 401k', offbudget: true });
    expect(plan.body.data.dry_run).toBe(true);
    expect(calls.some(c => c.name === 'api/account-create')).toBe(false);

    const apply = await request(server)
      .post('/machine/v1/accounts')
      .set(MACHINE_KEY_HEADER, key)
      .send({ name: 'Fidelity 401k', offbudget: true, dry_run: false, confirm_token: plan.body.data.confirm_token });
    expect(apply.status).toBe(200);
    expect(apply.body.data.id).toBe('acct-new');
    const create = calls.find(c => c.name === 'api/account-create');
    expect(create?.args).toEqual({ account: { name: 'Fidelity 401k', offbudget: true, closed: false }, initialBalance: null });
  });

  it('refuses a duplicate name as conflict', async () => {
    const { key } = fakeEngine();
    const res = await request(server)
      .post('/machine/v1/accounts')
      .set(MACHINE_KEY_HEADER, key)
      .send({ name: 'northbank checking ••4021' });
    expect(res.body.error.code).toBe('conflict');
  });
});

describe('POST /transactions/import', () => {
  it('the plan is the importer in preview mode, with the pinned options', async () => {
    const { key, calls } = fakeEngine();
    const res = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows });
    expect(res.status).toBe(200);
    expect(res.body.data.dry_run).toBe(true);
    expect(res.body.data.changes).toEqual({ added: 1, updated: 0, unchanged: 1, errors: [] });
    expect(res.body.data.confirm_token).toMatch(/^cf_/);

    const call = calls.find(c => c.name === 'api/transactions-import');
    const args = call?.args as { isPreview: boolean; opts: Record<string, unknown> };
    expect(args.isPreview).toBe(true);
    expect(args.opts).toEqual({
      dryRun: true,
      defaultCleared: true,
      reimportDeleted: false,
      payeeNameNormalization: 'title-case',
    });
  });

  it('refuses a non-integer amount naming the row', async () => {
    const { key } = fakeEngine();
    const res = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: [{ date: '2026-01-01', amount: 12.5 }] });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('transactions[0].amount');
  });

  it('applies with the token, syncs, and a second plan is all unchanged', async () => {
    const { key, calls } = fakeEngine();
    const plan = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows });

    const apply = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows, dry_run: false, confirm_token: plan.body.data.confirm_token });
    expect(apply.status).toBe(200);
    expect(apply.body.data.changes.added).toBe(1);
    expect(apply.body.data.added_ids).toEqual(['new-0']);
    expect(apply.body.data.sync.synced).toBe(false); // fake engine is not connected

    const real = calls.filter(c => c.name === 'api/transactions-import' && !(c.args as { isPreview: boolean }).isPreview);
    expect(real).toHaveLength(1);

    const again = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows });
    expect(again.body.data.changes).toEqual({ added: 0, updated: 0, unchanged: 2, errors: [] });
  });

  it('refuses an invented token and writes nothing', async () => {
    const { key, calls } = fakeEngine();
    const res = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows, dry_run: false, confirm_token: 'cf_nope' });
    expect(res.body.error.code).toBe('conflict');
    expect(calls.filter(c => c.name === 'api/transactions-import' && !(c.args as { isPreview: boolean }).isPreview)).toHaveLength(0);
  });

  it('refuses a token when the rows changed under it', async () => {
    const { key } = fakeEngine();
    const plan = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: rows });
    const res = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', transactions: [rows[1]], dry_run: false, confirm_token: plan.body.data.confirm_token });
    expect(res.body.error.code).toBe('conflict');
    expect(res.body.error.message).toContain('changed since');
  });

  it('enforces max_changes and reports the real count', async () => {
    const { key } = fakeEngine();
    const res = await request(server)
      .post('/machine/v1/transactions/import')
      .set(MACHINE_KEY_HEADER, key)
      .send({
        account_id: 'acct-1',
        transactions: [...rows, { date: '2026-02-06', amount: -100, imported_id: 'third' }],
        max_changes: 1,
      });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('would change 2 rows');
    expect(res.body.error.hint).toContain('max_changes: 2');
  });
});

describe('the file door', () => {
  it('plans an OFX through Actual\'s parser and applies it with the token', async () => {
    const { key, calls } = fakeEngine();
    const ofx = path.join(tmp, 'Checking_x4021_ALL_actual.ofx');
    fs.writeFileSync(ofx, 'OFXHEADER:100\n\n<OFX></OFX>\n');

    const plan = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: ofx });
    expect(plan.status).toBe(200);
    expect(plan.body.data.rows).toBe(2);
    expect(plan.body.data.rows_without_imported_id).toBe(0);
    expect(plan.body.data.changes).toEqual({ added: 1, updated: 0, unchanged: 1, errors: [] });
    expect(plan.body.data.date_range).toEqual({ first: '2026-02-03', last: '2026-02-05' });

    // The parser was asked to keep MEMO as notes and to fall back to memo for a missing payee.
    const parse = calls.find(c => c.name === 'transactions-parse-file');
    expect(parse?.args).toEqual({ filepath: ofx, options: { importNotes: true, fallbackMissingPayeeToMemo: true } });

    // Cents: -45.2 became -4520.
    const preview = calls.find(c => c.name === 'api/transactions-import');
    const sent = (preview?.args as { transactions: Array<{ amount: number; notes?: string }> }).transactions;
    expect(sent[0].amount).toBe(-4520);
    expect(sent[1].amount).toBe(120000);
    expect(sent[1].notes).toBe('Feb');

    const apply = await request(server)
      .post('/machine/v1/ingest/file/apply')
      .set(MACHINE_KEY_HEADER, key)
      .send({ confirm_token: plan.body.data.confirm_token, dry_run: false });
    expect(apply.status).toBe(200);
    expect(apply.body.data.dry_run).toBe(false);
    expect(apply.body.data.changes.added).toBe(1);
    expect(apply.body.data.file).toBe(ofx);
  });

  it('apply defaults to a dry run', async () => {
    const { key, calls } = fakeEngine();
    const ofx = path.join(tmp, 'x.ofx');
    fs.writeFileSync(ofx, '');
    const plan = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: ofx });
    const apply = await request(server)
      .post('/machine/v1/ingest/file/apply')
      .set(MACHINE_KEY_HEADER, key)
      .send({ confirm_token: plan.body.data.confirm_token });
    expect(apply.body.data.dry_run).toBe(true);
    expect(calls.filter(c => c.name === 'api/transactions-import' && !(c.args as { isPreview: boolean }).isPreview)).toHaveLength(0);
  });

  it('refuses a CSV and says why', async () => {
    const { key } = fakeEngine();
    const csv = path.join(tmp, 'x.csv');
    fs.writeFileSync(csv, 'Date,Payee,Amount\n');
    const res = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: csv });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.hint).toContain('imported_id');
  });

  it('refuses a file the parser could not fully read, importing nothing', async () => {
    const { key, calls } = fakeEngine();
    const bad = path.join(tmp, 'bad.ofx');
    fs.writeFileSync(bad, '');
    const res = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: bad });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('Invalid amount format');
    expect(calls.some(c => c.name === 'api/transactions-import')).toBe(false);
  });

  it('refuses a relative path and a missing file', async () => {
    const { key } = fakeEngine();
    const rel = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: 'x.ofx' });
    expect(rel.body.error.code).toBe('invalid_input');
    const missing = await request(server)
      .post('/machine/v1/ingest/file/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ account_id: 'acct-1', path: path.join(tmp, 'nope.ofx') });
    expect(missing.body.error.code).toBe('not_found');
  });
});

describe('GET /ingest/manifest', () => {
  it('reads the manifest and reports missing columns instead of guessing', async () => {
    const { key } = fakeEngine();
    const root = path.join(tmp, 'statements');
    fs.mkdirSync(path.join(root, 'import', 'personal', 'Northbank'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'import', 'personal', 'manifest_actual.csv'),
      'entity,institution,label,type,last4,kind,path,combined_ofx\n' +
        'household,Northbank,Checking_x4021,Checking_x4021,4021,checking,Northbank,Northbank/Checking_x4021_ALL_actual.ofx\n',
    );
    const res = await request(server)
      .get('/machine/v1/ingest/manifest')
      .query({ root })
      .set(MACHINE_KEY_HEADER, key);
    expect(res.status).toBe(200);
    expect(res.body.data.missing_columns).toEqual([]);
    expect(res.body.data.accounts[0].last4).toBe('4021');
    expect(res.body.data.accounts[0].combined_ofx_exists).toBe(false);
    expect(res.body.data.accounts[0].combined_ofx_absolute).toBe(
      path.join(root, 'import', 'personal', 'Northbank', 'Checking_x4021_ALL_actual.ofx'),
    );
  });
});

describe('the write switch', () => {
  it('turns every write route off on the server, both switches named', async () => {
    const { key } = fakeEngine();
    resetMachinePlaneForTests();
    const file = path.join(tmp, 'creds.json');
    initMachinePlane({ ABX_CREDENTIALS_FILE: file, ACTUAL_MACHINE_DATA_DIR: path.join(tmp, 'engine') });
    const res = await request(server)
      .post('/machine/v1/ingest/file/apply')
      .set(MACHINE_KEY_HEADER, key)
      .send({ confirm_token: 'cf_x', dry_run: false });
    expect(res.body.error.code).toBe('write_disabled');
    expect(res.body.error.hint).toContain('ACTUAL_MACHINE_ALLOW_WRITE=1');
    expect(res.body.error.hint).toContain('ABMCP_ALLOW_WRITE=1');
  });
});

describe('POST /ingest/accounts/plan and apply (§12)', () => {
  function manifestRoot(): string {
    const root = path.join(tmp, 'statements');
    fs.mkdirSync(path.join(root, 'import', 'personal'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'import', 'personal', 'manifest_actual.csv'),
      'entity,institution,label,type,last4,kind,import_group,path\n' +
        'personal,Northbank,Checking_x4021,Checking_x4021,4021,checking,import,personal/Northbank\n' +
        'personal,Northbank,Card_x8812,Card_x8812,8812,card,import,personal/Northbank\n' +
        'personal,Fidelity,Fidelity_401k,401k,,retirement,import,personal/Fidelity\n' +
        'personal,First_Tech,First_Tech_Mortgage,Mortgage_x5190,5190,mortgage,confirm,personal/First_Tech\n',
    );
    return root;
  }

  it('links on last4, creates the rest with the on-budget rule, and names them readably', async () => {
    const { key } = fakeEngine();
    const root = manifestRoot();
    const res = await request(server)
      .post('/machine/v1/ingest/accounts/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ root });
    expect(res.status).toBe(200);
    const plan = res.body.data.plan as Array<Record<string, unknown>>;
    expect(res.body.data.summary).toEqual({ create: 3, link: 1, ambiguous: 0 });
    expect(plan[0].action).toBe('link'); // ••4021 already exists in the fake
    expect(plan[1]).toMatchObject({ action: 'create', proposed: { name: 'Northbank Card ••8812', offbudget: false } });
    expect(plan[2]).toMatchObject({ action: 'create', proposed: { name: 'Fidelity 401k', offbudget: true } });
    expect(plan[3]).toMatchObject({ action: 'create', proposed: { name: 'First Tech Mortgage ••5190', offbudget: true } });
    expect(res.body.data.confirm_token).toMatch(/^cf_/);
  });

  it('filters by import_group and honours a naming template', async () => {
    const { key } = fakeEngine();
    const root = manifestRoot();
    const res = await request(server)
      .post('/machine/v1/ingest/accounts/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ root, import_group: 'confirm', naming: '{Entity} · {Institution} {Kind} ••{last4}' });
    expect(res.body.data.plan).toHaveLength(1);
    expect(res.body.data.plan[0].proposed.name).toBe('personal · First Tech Mortgage ••5190');
  });

  it('applies only the create rows, only with the token', async () => {
    const { key, calls } = fakeEngine();
    const root = manifestRoot();
    const plan = await request(server)
      .post('/machine/v1/ingest/accounts/plan')
      .set(MACHINE_KEY_HEADER, key)
      .send({ root, import_group: 'import' });
    const dry = await request(server)
      .post('/machine/v1/ingest/accounts/apply')
      .set(MACHINE_KEY_HEADER, key)
      .send({ confirm_token: plan.body.data.confirm_token });
    expect(dry.body.data.dry_run).toBe(true);
    expect(calls.some(c => c.name === 'api/account-create')).toBe(false);

    const apply = await request(server)
      .post('/machine/v1/ingest/accounts/apply')
      .set(MACHINE_KEY_HEADER, key)
      .send({ confirm_token: plan.body.data.confirm_token, dry_run: false });
    expect(apply.status).toBe(200);
    expect(apply.body.data.created.map((c: { name: string }) => c.name)).toEqual(['Northbank Card ••8812', 'Fidelity 401k']);
    expect(apply.body.data.linked[0].name).toBe('Northbank Checking ••4021');
    expect(calls.filter(c => c.name === 'api/account-create')).toHaveLength(2);
  });
});
