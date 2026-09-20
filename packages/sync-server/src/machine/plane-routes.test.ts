/**
 * P1 — the plane's own routes, the tier gate and input validation.
 *
 * pm/apis.mdx §6.3 (capabilities parity), §8.0 (the four diagnostic routes),
 * §5.7 (unknown fields are rejected), §6.1 (admin is not "write plus").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetEngineForTests, setEngineForTests } from './engine.js';
import { MACHINE_KEY_HEADER } from './machine-auth.js';
import { describeRoutes } from './route.js';
import { assertTier, grantsFromEnv } from './tier.js';
import { fields, takesNothing } from './validate.js';

import {
  initMachinePlane,
  machineRouter,
  resetMachinePlaneForTests,
  ROUTES,
} from './index.js';

let tmp: string;

function app(): express.Express {
  const a = express();
  a.use('/machine/v1', machineRouter);
  return a;
}

/** Arm the plane against a throwaway credentials file, never the real one. */
function arm(extra: NodeJS.ProcessEnv = {}): string {
  const key = crypto.randomBytes(32).toString('hex');
  const file = path.join(tmp, 'creds.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ actual_budget: { machine: { api_key: key } } }),
    { mode: 0o600 },
  );
  initMachinePlane({
    ABX_CREDENTIALS_FILE: file,
    ACTUAL_MACHINE_DATA_DIR: path.join(tmp, 'engine'),
    ...extra,
  });
  return key;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-p1-'));
  resetMachinePlaneForTests();
  resetEngineForTests();
});

afterEach(() => {
  resetMachinePlaneForTests();
  resetEngineForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('/capabilities is generated from the router, not a second list', () => {
  it('describes exactly the routes that are mounted', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/capabilities')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(200);

    const published = res.body.data.routes as Array<{ path: string }>;
    expect(published.map(r => r.path).sort()).toEqual(
      describeRoutes(ROUTES)
        .map(r => r.path)
        .sort(),
    );
  });

  it('every mounted route actually answers rather than falling through', async () => {
    const key = arm();
    const agent = request(app());

    for (const def of ROUTES) {
      const res = await agent[def.method.toLowerCase() as 'get' | 'post'](
        `/machine/v1${def.path}`,
      ).set(MACHINE_KEY_HEADER, key);

      // Whatever it answers, it must be OUR envelope — never the terminal
      // 404 that means "no such route", which is what a registry/router
      // mismatch would produce.
      expect(res.body).toHaveProperty('ok');
      expect(res.body?.error?.message).not.toBe('No such machine-plane route.');
    }
  });

  it('never advertises a planned route as working', async () => {
    const key = arm({ ACTUAL_MACHINE_ALLOW_WRITE: '1' });
    const res = await request(app())
      .get('/machine/v1/capabilities')
      .set(MACHINE_KEY_HEADER, key);

    const planned = (
      res.body.data.routes as Array<{
        path: string;
        status: Record<string, string>;
      }>
    ).filter(r => Object.values(r.status).includes('planned'));

    // Whatever is declared-but-unbuilt must say so here AND refuse on call.
    for (const p of planned) {
      const res2 = await request(app())
        .post(`/machine/v1${p.path}`)
        .set(MACHINE_KEY_HEADER, key);
      expect(res2.body.error.code).toBe('not_ready');
    }
    expect(planned.length).toBeGreaterThan(0);
  });
});

describe('the diagnostic routes answer without an engine (§8.0)', () => {
  it('/ping reports the key fingerprint and never the key', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(key);
    expect(res.body.data.keyFingerprint).toContain('sha256:');
  });

  it('/whoami reports the engine as idle rather than failing', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/whoami')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(200);
    expect(res.body.data.engine.status).toBe('idle');
    expect(res.body.data.budget).toBeNull();
  });

  it('/health is NOT healthy with no budget open, and says what to do', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/health')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(200);
    expect(res.body.data.healthy).toBe(false);
    expect(typeof res.body.data.hint).toBe('string');
    expect(res.body.data.hint.length).toBeGreaterThan(0);
  });

  it('/health is healthy, and meta names the budget, once one is open', async () => {
    const key = arm();
    setEngineForTests({
      api: {
        init: async () => ({ send: async () => null, getDataDir: () => tmp }),
        shutdown: async () => undefined,
        getBudgets: async () => [{ id: 'b1', name: 'Test Budget' }],
        loadBudget: async () => undefined,
      },
      lib: { send: async () => null, getDataDir: () => tmp },
      budget: { id: 'b1', name: 'Test Budget' },
    });

    const res = await request(app())
      .get('/machine/v1/health')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.body.data.healthy).toBe(true);
    expect(res.body.meta.budgetId).toBe('b1');
    expect(res.body.meta.budgetName).toBe('Test Budget');
  });
});

describe('every response carries the budget it came from (§5.1)', () => {
  it('stamps target, serverVersion, asOf and tookMs on success', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.body.meta.target).toBe('local');
    expect(res.body.meta).toHaveProperty('serverVersion');
    expect(res.body.meta).toHaveProperty('asOf');
    expect(typeof res.body.meta.tookMs).toBe('number');
    expect(res.body.meta.tier).toBe('read');
  });
});

describe('gate 5 — unknown input is refused, never ignored (§5.7)', () => {
  it('rejects an argument sent to a route that takes none', async () => {
    const key = arm();
    const res = await request(app())
      .get('/machine/v1/ping?start=2026-01-01')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_input');
    expect(res.body.error.message).toContain('start');
  });

  it('names the accepted fields when one is misspelled', () => {
    const v = fields({ start: { type: 'string' }, end: { type: 'string' } });
    expect(() => v({ start_date: '2026-01-01' }, 'query')).toThrowError(
      /Unknown query field: start_date/,
    );
    try {
      v({ start_date: 'x' }, 'query');
    } catch (err) {
      expect((err as { hint: string }).hint).toContain('start, end');
    }
  });

  it('treats the string "false" as false, not as a truthy string', () => {
    const v = fields<{ include_closed?: boolean }>({
      include_closed: { type: 'boolean' },
    });
    expect(v({ include_closed: 'false' }, 'query').include_closed).toBe(false);
    expect(v({ include_closed: '0' }, 'query').include_closed).toBe(false);
    expect(v({ include_closed: 'true' }, 'query').include_closed).toBe(true);
  });

  it('refuses a decimal where a whole number is required', () => {
    const v = fields({ amount: { type: 'integer' } });
    expect(() => v({ amount: '12.5' }, 'body')).toThrowError(
      /must be a whole number/,
    );
  });

  it('refuses a value outside an enum, naming the options', () => {
    const v = fields({ format: { type: 'string', enum: ['json', 'csv'] } });
    expect(() => v({ format: 'xml' }, 'query')).toThrowError(/json, csv/);
  });

  it('takesNothing accepts an empty query', () => {
    expect(takesNothing()({}, 'query')).toEqual({});
  });
});

describe('gate 4 — admin is not "write plus" (§6.1)', () => {
  it('read always passes', () => {
    expect(() =>
      assertTier('read', { read: true, write: false, admin: false }),
    ).not.toThrow();
  });

  it('the write tier does NOT grant admin', () => {
    expect(() =>
      assertTier('admin', { read: true, write: true, admin: false }),
    ).toThrowError(/admin tier/);
  });

  it('the admin tier does NOT grant write', () => {
    expect(() =>
      assertTier('write', { read: true, write: false, admin: true }),
    ).toThrowError(/write tier is off/);
  });

  it('names both switches when a write is refused', () => {
    try {
      assertTier('write', { read: true, write: false, admin: false });
    } catch (err) {
      const hint = (err as { hint: string }).hint;
      expect(hint).toContain('ACTUAL_MACHINE_ALLOW_WRITE=1');
      expect(hint).toContain('ABMCP_ALLOW_WRITE=1');
    }
  });

  it('reads both switches off by default, and only for the exact flag', () => {
    expect(grantsFromEnv({})).toEqual({
      read: true,
      write: false,
      admin: false,
    });
    expect(grantsFromEnv({ ACTUAL_MACHINE_ALLOW_WRITE: 'true' }).write).toBe(
      false,
    );
    expect(grantsFromEnv({ ACTUAL_MACHINE_ALLOW_ADMIN: '1' }).admin).toBe(true);
    expect(grantsFromEnv({ ACTUAL_MACHINE_ALLOW_ADMIN: '1' }).write).toBe(
      false,
    );
  });

  it('reports the admin tier over the wire so it is auditable', async () => {
    const key = arm({ ACTUAL_MACHINE_ALLOW_ADMIN: '1' });
    const res = await request(app())
      .get('/machine/v1/whoami')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.body.data.tiers).toEqual({
      read: true,
      write: false,
      admin: true,
    });
  });
});

describe('the leak canary (§16.2)', () => {
  it('no route leaks the key, a secret, or a home directory path', async () => {
    const key = arm({ ACTUAL_MACHINE_ALLOW_WRITE: '1' });
    const agent = request(app());

    for (const def of ROUTES) {
      const res = await agent[def.method.toLowerCase() as 'get' | 'post'](
        `/machine/v1${def.path}`,
      ).set(MACHINE_KEY_HEADER, key);

      const body = JSON.stringify(res.body);
      expect(body).not.toContain(key);
      expect(body).not.toMatch(/"[0-9a-f]{64}"/);
      expect(body.toLowerCase()).not.toContain('password');
      // The engine's dataDir is legitimately a path and is reported on
      // purpose; it is the CONFIGURED one, which under test is the temp dir.
      expect(body).not.toContain(os.homedir() + '/.credentials');
    }
  });
});
