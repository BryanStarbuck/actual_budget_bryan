/**
 * The machine plane mounts inside an app that calls `app.use(cors())` with no
 * options. These tests reproduce that exactly, because the interaction — not
 * either piece alone — is what decides whether the plane is safe.
 */
import crypto from 'node:crypto';

import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { MACHINE_KEY_HEADER, machineAuthMiddleware } from './machine-auth.js';

const KEY = crypto.randomBytes(32).toString('hex');

function appAsDeployed() {
  const app = express();
  // Reproduced from packages/sync-server/src/app.ts, lines 30-31.
  app.use(cors());
  app.set('trust proxy', true);

  app.use(
    '/machine/v1',
    machineAuthMiddleware({ key: KEY, allowWrite: false }),
  );
  app.get('/machine/v1/ping', (_req, res) => {
    res.json({ ok: true });
  });

  // A non-plane route, to prove we only strip CORS from ours.
  app.get('/health', (_req, res) => {
    res.json({ status: 'UP' });
  });
  return app;
}

describe('the plane inside the app-wide cors()', () => {
  it('strips the permissive CORS header the surrounding app added', async () => {
    const res = await request(appAsDeployed())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY);

    expect(res.status).toBe(200);
    // cors() put `*` here before we ran. Advertising an open CORS policy on
    // the surface holding the operator's ledger is wrong even though the
    // origin gate means no browser gets an answer.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it("leaves the rest of the app's CORS behaviour alone", async () => {
    const res = await request(appAsDeployed()).get('/health');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('strips CORS on a refusal too, not just on an answer', async () => {
    const res = await request(appAsDeployed())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY)
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(404);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never caches, answer or refusal', async () => {
    const answered = await request(appAsDeployed())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY);
    const refused = await request(appAsDeployed()).get('/machine/v1/ping');

    for (const res of [answered, refused]) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['vary']).toBe('Origin');
    }
  });
});
