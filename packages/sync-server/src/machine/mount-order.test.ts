/**
 * Mount-order regression tests — pm/cli.mdx §5.1.
 *
 * These exist because of a bug that every other test in this directory
 * passed straight through, and that only a real server caught.
 *
 * app.ts registers an SPA catch-all at module scope in production
 * (`app.get('/{*splat}', …)` -> index.html) and proxies everything to Vite in
 * development. Express matches in registration order, so a machine plane
 * mounted AFTER either one never runs. The symptom is not a 404 and not a
 * crash: `/machine/v1/ping` returns **index.html with status 200**, and the
 * CLI reports "answered 200 with no JSON body" — which reads like a port
 * conflict, not a routing mistake, and sends you looking in the wrong place.
 *
 * The unit tests could not catch it because they mount the router on a bare
 * Express app with no catch-all. So these reproduce the catch-all explicitly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MACHINE_KEY_HEADER } from './machine-auth.js';

import {
  initMachinePlane,
  machineRouter,
  resetMachinePlaneForTests,
} from './index.js';

let dir: string;
let credentialsFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abx-mount-'));
  credentialsFile = path.join(dir, 'actual_budget.json');
  resetMachinePlaneForTests();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetMachinePlaneForTests();
});

/** app.ts's shape: route mounts first, SPA catch-all last. */
function appWithSpaFallback() {
  const app = express();
  app.use('/machine/v1', machineRouter);

  // Reproduced from app.ts's production branch.
  app.get('/{*splat}', (_req, res) => {
    res.status(200).type('html').send('<!doctype html><html>SPA</html>');
  });
  return app;
}

function armPlane(): string {
  const info = initMachinePlane({ ABX_CREDENTIALS_FILE: credentialsFile });
  expect(info).not.toBeNull();
  return JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).actual_budget
    .machine.api_key as string;
}

describe('the plane beats the SPA catch-all', () => {
  it('answers JSON, not index.html, when a catch-all exists', async () => {
    const key = armPlane();

    const res = await request(appWithSpaFallback())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(200);
    // The exact assertion the original bug needed: a 200 is not enough,
    // because the SPA fallback also returns 200.
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.ok).toBe(true);
    expect(res.text).not.toContain('SPA');
  });

  it('a REFUSAL is also JSON, not index.html', async () => {
    armPlane();

    // No key. If the catch-all were winning, this would be a 200 of HTML and
    // the CLI would never see the 401 it needs to report exit 6.
    const res = await request(appWithSpaFallback()).get('/machine/v1/ping');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: { code: 'unauthorized' } });
  });

  it('an unknown machine-plane route 404s rather than serving the SPA', async () => {
    const key = armPlane();

    const res = await request(appWithSpaFallback())
      .get('/machine/v1/no-such-route')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.text).not.toContain('SPA');
  });
});

describe('fail closed before the key is resolved (R9)', () => {
  it('404s every machine-plane request until initMachinePlane() runs', async () => {
    // Router mounted, never armed — the state during module import, and the
    // state on a server that could not resolve a key at all.
    const res = await request(appWithSpaFallback())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, crypto.randomBytes(32).toString('hex'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      ok: false,
      error: { code: 'not_found', message: 'Not found.' },
    });
  });
});

describe('the key is resolved at boot, not at import', () => {
  it('importing this module writes no credentials file', () => {
    // The import already happened at the top of this file. If resolving the
    // key were a module-scope side effect, every test run in this package
    // would write a secret into the developer's real home directory.
    expect(fs.existsSync(credentialsFile)).toBe(false);
  });

  it('initMachinePlane() is what mints it, at 0600', () => {
    const info = initMachinePlane({ ABX_CREDENTIALS_FILE: credentialsFile });

    expect(fs.existsSync(credentialsFile)).toBe(true);
    expect(fs.statSync(credentialsFile).mode & 0o777).toBe(0o600);
    // Only ever the fingerprint leaves this function (R2).
    expect(info?.keyFingerprint).toMatch(/^[0-9a-f]{4}…\/sha256:[0-9a-f]{4}$/);
  });

  it('defaults the write tier OFF, and turns it on only for the exact flag', () => {
    expect(
      initMachinePlane({ ABX_CREDENTIALS_FILE: credentialsFile })?.allowWrite,
    ).toBe(false);

    resetMachinePlaneForTests();
    expect(
      initMachinePlane({
        ABX_CREDENTIALS_FILE: credentialsFile,
        ACTUAL_MACHINE_ALLOW_WRITE: 'true',
      })?.allowWrite,
    ).toBe(false);

    resetMachinePlaneForTests();
    expect(
      initMachinePlane({
        ABX_CREDENTIALS_FILE: credentialsFile,
        ACTUAL_MACHINE_ALLOW_WRITE: '1',
      })?.allowWrite,
    ).toBe(true);
  });
});

describe('the write tier gate', () => {
  it('refuses a write route when the tier is off, with both switches named', async () => {
    const key = armPlane();

    const res = await request(appWithSpaFallback())
      .post('/machine/v1/sync')
      .set(MACHINE_KEY_HEADER, key);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('write_disabled');
    expect(res.body.error.hint).toContain('ACTUAL_MACHINE_ALLOW_WRITE=1');
  });
});
