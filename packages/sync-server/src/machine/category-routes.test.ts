/**
 * The category tree and categorise-by-import, through the real router with a
 * fake engine — pm/apis.mdx §8.3a, §8.4a.
 *
 * Every name and id here is synthetic. The fake engine records every `send`,
 * so the tests can assert the only write categorise-by-import ever makes is
 * `api/transaction-update` with a `category` field and nothing else.
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
import { buildTree, treeYaml } from './routes/categories.js';
import { quoteIfNeeded } from './yaml.js';

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

const GROUPS = [
  {
    id: 'g-food',
    name: 'Food',
    is_income: false,
    hidden: false,
    categories: [
      {
        id: 'c-groc',
        name: 'Groceries',
        is_income: false,
        hidden: false,
        group_id: 'g-food',
      },
      {
        id: 'c-dine',
        name: 'Dining: Out & About',
        is_income: false,
        hidden: false,
        group_id: 'g-food',
      },
      {
        id: 'c-old',
        name: 'Old Snacks',
        is_income: false,
        hidden: true,
        group_id: 'g-food',
      },
    ],
  },
  {
    id: 'g-home',
    name: 'Home',
    is_income: false,
    hidden: false,
    categories: [
      {
        id: 'c-misc-h',
        name: 'Misc',
        is_income: false,
        hidden: false,
        group_id: 'g-home',
      },
    ],
  },
  {
    id: 'g-fun',
    name: 'Fun',
    is_income: false,
    hidden: true,
    categories: [
      {
        id: 'c-misc-f',
        name: 'Misc',
        is_income: false,
        hidden: false,
        group_id: 'g-fun',
      },
    ],
  },
  {
    id: 'g-inc',
    name: 'Income',
    is_income: true,
    hidden: false,
    categories: [
      {
        id: 'c-pay',
        name: 'Paycheck',
        is_income: true,
        hidden: false,
        group_id: 'g-inc',
      },
    ],
  },
];

function fakeEngine(): {
  calls: Call[];
  ledger: Map<string, Record<string, unknown>>;
} {
  const calls: Call[] = [];
  const accounts = [
    {
      id: 'acct-1',
      name: 'Northbank Checking ••4021',
      offbudget: false,
      closed: false,
    },
    {
      id: 'acct-2',
      name: 'Harbor Card ••7788',
      offbudget: false,
      closed: false,
    },
  ];
  const ledger = new Map<string, Record<string, unknown>>([
    [
      't1',
      {
        id: 't1',
        account: 'acct-1',
        date: '2026-02-03',
        amount: -4520,
        category: null,
        imported_id: 'FIT-0001',
      },
    ],
    [
      't2',
      {
        id: 't2',
        account: 'acct-1',
        date: '2026-02-04',
        amount: -1200,
        category: 'c-groc',
        imported_id: 'FIT-0002',
      },
    ],
    [
      't3',
      {
        id: 't3',
        account: 'acct-1',
        date: '2026-02-05',
        amount: -9900,
        category: null,
        imported_id: 'FIT-0003',
        is_parent: true,
      },
    ],
    [
      't4',
      {
        id: 't4',
        account: 'acct-1',
        date: '2026-02-06',
        amount: -50000,
        category: null,
        imported_id: 'FIT-0004',
        transfer_id: 't9',
      },
    ],
    [
      't5',
      {
        id: 't5',
        account: 'acct-1',
        date: '2026-02-07',
        amount: -300,
        category: null,
        imported_id: 'FIT-DUP',
      },
    ],
    [
      't6',
      {
        id: 't6',
        account: 'acct-1',
        date: '2026-02-07',
        amount: -300,
        category: null,
        imported_id: 'FIT-DUP',
      },
    ],
    [
      't7',
      {
        id: 't7',
        account: 'acct-2',
        date: '2026-02-08',
        amount: -2500,
        category: 'c-dine',
        imported_id: 'FIT-0001',
      },
    ],
  ]);

  const send = async (name: string, args?: unknown): Promise<unknown> => {
    calls.push({ name, args });
    const a = (args ?? {}) as Record<string, unknown>;
    switch (name) {
      case 'api/accounts-get':
        return accounts;
      case 'api/category-groups-get':
        if (a.hidden === false) {
          return GROUPS.filter(g => !g.hidden).map(g => ({
            ...g,
            categories: g.categories.filter(c => !c.hidden),
          }));
        }
        return GROUPS;
      case 'api/transactions-get':
        return [...ledger.values()].filter(t => t.account === a.accountId);
      case 'api/transaction-update': {
        const t = ledger.get(a.id as string);
        if (t) Object.assign(t, a.fields as object);
        return [];
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
  return { calls, ledger };
}

let key: string;

function arm(allowWrite: boolean): void {
  key = crypto.randomBytes(32).toString('hex');
  const file = path.join(tmp, 'creds.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ actual_budget: { machine: { api_key: key } } }),
    { mode: 0o600 },
  );
  initMachinePlane({
    ABX_CREDENTIALS_FILE: file,
    ACTUAL_MACHINE_DATA_DIR: path.join(tmp, 'engine'),
    ...(allowWrite ? { ACTUAL_MACHINE_ALLOW_WRITE: '1' } : {}),
  });
}

function get(url: string) {
  return request(server).get(`/machine/v1${url}`).set(MACHINE_KEY_HEADER, key);
}

function post(url: string, body: unknown) {
  return request(server)
    .post(`/machine/v1${url}`)
    .set(MACHINE_KEY_HEADER, key)
    .send(body as object);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-categories-'));
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

describe('YAML quoting', () => {
  it('leaves ordinary names plain', () => {
    for (const plain of [
      'Groceries',
      "Kid's Stuff",
      'Car - Fuel',
      'Gifts (family)',
      'Rent/Mortgage',
      'Misc',
    ]) {
      expect(quoteIfNeeded(plain)).toBe(plain);
    }
  });

  it('quotes anything a YAML parser could read as something else', () => {
    const cases: Record<string, string> = {
      'Travel: Air': '"Travel: Air"',
      'Fees #2': '"Fees #2"',
      'Food & Drink': '"Food & Drink"',
      '*Starred': '"*Starred"',
      '- Leading dash': '"- Leading dash"',
      Yes: '"Yes"',
      no: '"no"',
      NULL: '"NULL"',
      '2026': '"2026"',
      '401k': '"401k"',
      ' padded': '" padded"',
      'trailing ': '"trailing "',
      'say "hi"': '"say \\"hi\\""',
      '': '""',
      '[x]': '"[x]"',
      '@home': '"@home"',
    };
    for (const [input, expected] of Object.entries(cases)) {
      expect(quoteIfNeeded(input), input).toBe(expected);
    }
  });

  it('writes the shared tree shape, ids always quoted, empty lists inline', () => {
    const tree = buildTree(
      [
        {
          id: 'g1',
          name: 'Food',
          is_income: false,
          hidden: false,
          categories: [
            {
              id: 'c1',
              name: 'Groceries',
              is_income: false,
              hidden: false,
              group_id: 'g1',
            },
            {
              id: 'c2',
              name: 'Dining: Out',
              is_income: false,
              hidden: false,
              group_id: 'g1',
            },
          ],
        },
        {
          id: 'g2',
          name: 'Empty',
          is_income: true,
          hidden: true,
          categories: [],
        },
      ],
      new Date('2026-09-21T22:00:00.123Z'),
    );
    expect(treeYaml(tree)).toBe(
      [
        'app: actual_budget',
        'generated_at: 2026-09-21T22:00:00Z',
        'counts:',
        '  groups: 2',
        '  subcategories: 2',
        'groups:',
        '  - name: Food',
        '    type: expense',
        '    id: "g1"',
        '    hidden: false',
        '    subcategories:',
        '      - name: Groceries',
        '        id: "c1"',
        '        hidden: false',
        '      - name: "Dining: Out"',
        '        id: "c2"',
        '        hidden: false',
        '  - name: Empty',
        '    type: income',
        '    id: "g2"',
        '    hidden: true',
        '    subcategories: []',
        '',
      ].join('\n'),
    );
  });
});

describe('GET /categories/tree', () => {
  it('returns the visible tree in engine order, with the YAML beside it', async () => {
    fakeEngine();
    arm(false);
    const res = await get('/categories/tree');
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({
      budgetId: 'b1',
      budgetName: 'Test Budget',
      tier: 'read',
    });
    const d = res.body.data;
    expect(d.app).toBe('actual_budget');
    expect(d.counts).toEqual({ groups: 3, subcategories: 4 });
    expect(d.groups.map((g: { name: string }) => g.name)).toEqual([
      'Food',
      'Home',
      'Income',
    ]);
    expect(d.groups[0]).toEqual({
      name: 'Food',
      id: 'g-food',
      type: 'expense',
      hidden: false,
      subcategories: [
        { name: 'Groceries', id: 'c-groc', hidden: false },
        { name: 'Dining: Out & About', id: 'c-dine', hidden: false },
      ],
    });
    expect(d.groups[2].type).toBe('income');
    expect(d.yaml).toContain('app: actual_budget\n');
    expect(d.yaml).toContain('      - name: "Dining: Out & About"\n');
    expect(d.yaml).not.toContain('Old Snacks');
    expect(d.yaml).toContain(`generated_at: ${d.generated_at}\n`);
  });

  it('includes hidden groups and categories on include_hidden=true', async () => {
    fakeEngine();
    arm(false);
    const res = await get('/categories/tree?include_hidden=true');
    expect(res.body.data.counts).toEqual({ groups: 4, subcategories: 6 });
    expect(res.body.data.yaml).toContain('Old Snacks');
  });

  it('format=yaml keeps the envelope and carries only the document', async () => {
    fakeEngine();
    arm(false);
    const res = await get('/categories/tree?format=yaml');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'app',
      'counts',
      'yaml',
    ]);
  });

  it('rejects an unknown format and an unknown argument', async () => {
    fakeEngine();
    arm(false);
    expect((await get('/categories/tree?format=xml')).body.error.code).toBe(
      'invalid_input',
    );
    expect((await get('/categories/tree?hidden=true')).body.error.code).toBe(
      'invalid_input',
    );
  });

  it('is published live in /capabilities', async () => {
    fakeEngine();
    arm(false);
    const res = await get('/capabilities');
    const routes = res.body.data.routes as Array<{
      path: string;
      status: Record<string, string>;
    }>;
    expect(routes.find(r => r.path === '/categories/tree')?.status.GET).toBe(
      'live',
    );
    expect(
      routes.find(r => r.path === '/transactions/categorize-by-import/plan')
        ?.status.POST,
    ).toBe('live');
  });
});

describe('POST /transactions/categorize-by-import', () => {
  const assignments = [
    {
      account: 'acct-1',
      imported_id: 'FIT-0001',
      category: 'Food > Groceries',
    }, // change
    {
      account: 'northbank checking ••4021',
      imported_id: 'FIT-0002',
      category: 'c-groc',
    }, // unchanged, by name + id
    { account: 'acct-1', imported_id: 'FIT-9999', category: 'Groceries' }, // not_found
    { account: 'acct-1', imported_id: 'FIT-0003', category: 'Groceries' }, // split_parent
    { account: 'acct-1', imported_id: 'FIT-0004', category: 'Groceries' }, // transfer
    { account: 'acct-1', imported_id: 'FIT-DUP', category: 'Groceries' }, // ambiguous_row
    { account: 'acct-2', imported_id: 'FIT-0001', category: 'Misc' }, // ambiguous_category
    { account: 'acct-2', imported_id: 'FIT-0005', category: 'Food > Pet Food' }, // unknown_category
    {
      account: 'Nowhere Savings',
      imported_id: 'FIT-0001',
      category: 'Groceries',
    }, // unknown_account
    { account: 'acct-1', imported_id: 'FIT-0001', category: 'Home > Misc' }, // duplicate_assignment
  ];

  it('plans without the write tier and reports every row', async () => {
    const { calls } = fakeEngine();
    arm(false);
    const res = await post('/transactions/categorize-by-import/plan', {
      assignments,
    });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.dry_run).toBe(true);
    expect(d.confirm_token).toMatch(/^cf_/);
    expect(d.counts).toEqual({
      rows: 10,
      matched: 4,
      changed: 1,
      unchanged: 1,
      not_found: 1,
      unknown_account: 1,
      ambiguous_account: 0,
      unknown_category: 1,
      ambiguous_category: 1,
      ambiguous_row: 1,
      split_parent: 1,
      transfer: 1,
      duplicate_assignment: 1,
    });
    expect(d.rows.map((r: { status: string }) => r.status)).toEqual([
      'change',
      'unchanged',
      'not_found',
      'split_parent',
      'transfer',
      'ambiguous_row',
      'ambiguous_category',
      'unknown_category',
      'unknown_account',
      'duplicate_assignment',
    ]);
    expect(d.rows[0]).toMatchObject({
      transaction_id: 't1',
      from: null,
      to: { id: 'c-groc', path: 'Food > Groceries', hidden: false },
    });
    expect(d.rows[6].candidates).toEqual(['Home > Misc', 'Fun > Misc']);
    expect(d.within_max_changes).toBe(true);
    // Nothing written, and no category created.
    expect(calls.some(c => c.name === 'api/transaction-update')).toBe(false);
    expect(
      calls.some(c => /category-create|category-group-create/.test(c.name)),
    ).toBe(false);
  });

  it('applies only the change rows, touching only category, then syncs', async () => {
    const { calls, ledger } = fakeEngine();
    arm(true);
    const planned = await post('/transactions/categorize-by-import/plan', {
      assignments,
    });
    const token = planned.body.data.confirm_token;

    const dry = await post('/transactions/categorize-by-import/apply', {
      confirm_token: token,
    });
    expect(dry.body.data.dry_run).toBe(true);
    expect(calls.some(c => c.name === 'api/transaction-update')).toBe(false);

    const res = await post('/transactions/categorize-by-import/apply', {
      confirm_token: token,
      dry_run: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.changed).toEqual([
      {
        transaction_id: 't1',
        from: null,
        to: { id: 'c-groc', path: 'Food > Groceries', hidden: false },
      },
    ]);
    const writes = calls.filter(c => c.name === 'api/transaction-update');
    expect(writes).toEqual([
      {
        name: 'api/transaction-update',
        args: { id: 't1', fields: { category: 'c-groc' } },
      },
    ]);
    expect(ledger.get('t1')?.category).toBe('c-groc');
    expect(ledger.get('t7')?.category).toBe('c-dine');

    // Single use.
    const again = await post('/transactions/categorize-by-import/apply', {
      confirm_token: token,
      dry_run: false,
    });
    expect(again.body.error.code).toBe('conflict');
  });

  it('refuses the apply when the ledger moved after the plan', async () => {
    const { ledger, calls } = fakeEngine();
    arm(true);
    const planned = await post('/transactions/categorize-by-import/plan', {
      assignments,
    });
    ledger.get('t1')!.category = 'c-dine'; // categorised in the browser meanwhile
    const res = await post('/transactions/categorize-by-import/apply', {
      confirm_token: planned.body.data.confirm_token,
      dry_run: false,
    });
    expect(res.body.error.code).toBe('conflict');
    expect(calls.some(c => c.name === 'api/transaction-update')).toBe(false);
  });

  it('refuses the apply without the write tier', async () => {
    fakeEngine();
    arm(false);
    const planned = await post('/transactions/categorize-by-import/plan', {
      assignments,
    });
    const res = await post('/transactions/categorize-by-import/apply', {
      confirm_token: planned.body.data.confirm_token,
      dry_run: false,
    });
    expect(res.body.error.code).toBe('write_disabled');
  });

  it('refuses an apply over max_changes and says so in the plan', async () => {
    const { calls } = fakeEngine();
    arm(true);
    const two = [
      {
        account: 'acct-1',
        imported_id: 'FIT-0001',
        category: 'Food > Groceries',
      },
      {
        account: 'acct-2',
        imported_id: 'FIT-0001',
        category: 'Income > Paycheck',
      },
    ];
    const planned = await post('/transactions/categorize-by-import/plan', {
      assignments: two,
      max_changes: 1,
    });
    expect(planned.body.data.counts.changed).toBe(2);
    expect(planned.body.data.within_max_changes).toBe(false);
    const res = await post('/transactions/categorize-by-import/apply', {
      confirm_token: planned.body.data.confirm_token,
      dry_run: false,
    });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('2 rows');
    expect(calls.some(c => c.name === 'api/transaction-update')).toBe(false);
  });

  it('names the index and field of a malformed assignment', async () => {
    fakeEngine();
    arm(false);
    const res = await post('/transactions/categorize-by-import/plan', {
      assignments: [
        {
          account: 'acct-1',
          imported_id: 'FIT-0001',
          category: 'Food > Groceries',
        },
        { account: 'acct-1', imported_id: '' },
      ],
    });
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('assignments[1].imported_id');
    const extra = await post('/transactions/categorize-by-import/plan', {
      assignments: [
        {
          account: 'acct-1',
          imported_id: 'FIT-0001',
          category: 'x',
          create: true,
        },
      ],
    });
    expect(extra.body.error.message).toContain('unknown field');
  });
});
