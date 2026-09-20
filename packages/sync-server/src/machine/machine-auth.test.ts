import crypto from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  constantTimeEquals,
  isBrowserOrigin,
  isLoopbackSocket,
  MACHINE_KEY_HEADER,
  machineAuthMiddleware,
} from './machine-auth.js';

const KEY = crypto.randomBytes(32).toString('hex');

function appWithPlane({ allowWrite = false } = {}) {
  const app = express();
  // Reproduce the two things the real app does to us (pm/cli.mdx §4.4a):
  // a permissive CORS layer and a globally trusted proxy.
  app.set('trust proxy', true);
  app.use('/machine/v1', machineAuthMiddleware({ key: KEY, allowWrite }));
  app.get('/machine/v1/ping', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

/** A request object shaped just enough for the pure predicates. */
function fakeReq(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {},
) {
  return {
    socket: { remoteAddress },
    get(name: string) {
      return headers[name.toLowerCase()];
    },
  } as unknown as express.Request;
}

describe('isLoopbackSocket', () => {
  it('accepts every shape a local client actually arrives as', () => {
    expect(isLoopbackSocket(fakeReq('127.0.0.1'))).toBe(true);
    expect(isLoopbackSocket(fakeReq('::1'))).toBe(true);
    // A dual-stack listener reports an IPv4 client this way; omitting it makes
    // the plane unreachable on exactly the machines it is meant for.
    expect(isLoopbackSocket(fakeReq('::ffff:127.0.0.1'))).toBe(true);
    expect(isLoopbackSocket(fakeReq('127.0.0.53'))).toBe(true);
  });

  it('rejects anything else, including a missing peer address', () => {
    expect(isLoopbackSocket(fakeReq('10.0.0.4'))).toBe(false);
    expect(isLoopbackSocket(fakeReq('192.168.1.9'))).toBe(false);
    expect(isLoopbackSocket(fakeReq(undefined))).toBe(false);
  });

  it('IGNORES X-Forwarded-For — the header trust proxy would believe', () => {
    // This is the whole point of reading req.socket.remoteAddress. With
    // `trust proxy` set app-wide, req.ip would report 127.0.0.1 here and a
    // gate written against it would let a remote attacker straight through.
    const spoofed = fakeReq('203.0.113.7', {
      'x-forwarded-for': '127.0.0.1',
      'x-real-ip': '127.0.0.1',
    });
    expect(isLoopbackSocket(spoofed)).toBe(false);
  });
});

describe('isBrowserOrigin', () => {
  it('treats a foreign Origin as a browser', () => {
    expect(
      isBrowserOrigin(fakeReq('127.0.0.1', { origin: 'https://evil.example' })),
    ).toBe(true);
  });

  it('treats a cross-site fetch as a browser even with no Origin', () => {
    expect(
      isBrowserOrigin(fakeReq('127.0.0.1', { 'sec-fetch-site': 'cross-site' })),
    ).toBe(true);
    expect(
      isBrowserOrigin(fakeReq('127.0.0.1', { 'sec-fetch-site': 'same-site' })),
    ).toBe(true);
  });

  it('lets our own dev UI through', () => {
    expect(
      isBrowserOrigin(
        fakeReq('127.0.0.1', { origin: 'http://localhost:3001' }),
      ),
    ).toBe(false);
  });

  it('lets a non-browser client through — abx and curl send neither header', () => {
    expect(isBrowserOrigin(fakeReq('127.0.0.1'))).toBe(false);
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal values without throwing on a length mismatch', () => {
    expect(constantTimeEquals(KEY, KEY)).toBe(true);
    expect(constantTimeEquals(KEY, 'short')).toBe(false);
    expect(constantTimeEquals('', KEY)).toBe(false);
  });
});

describe('the gate ladder', () => {
  it('answers a correctly-keyed loopback request', async () => {
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY);
    expect(res.status).toBe(200);
  });

  it('401s a wrong key and a missing key with a BYTE-IDENTICAL body', async () => {
    const missing = await request(appWithPlane()).get('/machine/v1/ping');
    const wrong = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, crypto.randomBytes(32).toString('hex'));

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    // The server never says which one it was; the CLI does the explaining.
    expect(wrong.text).toBe(missing.text);
    expect(missing.body).toEqual({
      ok: false,
      error: { code: 'unauthorized' },
    });
  });

  it('404s a browser Origin even when the key is VALID', async () => {
    // app.use(cors()) is global and permissive, so a page the operator visits
    // really can reach 127.0.0.1 — over loopback. The key stops it; this gate
    // is the second wall so that is not one control deep.
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY)
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(404);
  });

  it('404s a cross-site Sec-Fetch-Site even when the key is valid', async () => {
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY)
      .set('Sec-Fetch-Site', 'cross-site');

    expect(res.status).toBe(404);
  });

  it('404s a rebound Host even when the key is valid', async () => {
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY)
      .set('Host', 'budget.evil.example');

    expect(res.status).toBe(404);
  });

  it('never caches an answer', async () => {
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['vary']).toBe('Origin');
  });

  it('sets no Access-Control-Allow-Origin of its own', async () => {
    const res = await request(appWithPlane())
      .get('/machine/v1/ping')
      .set(MACHINE_KEY_HEADER, KEY);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
