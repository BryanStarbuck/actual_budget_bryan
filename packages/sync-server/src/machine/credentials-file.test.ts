import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assertSafeMode,
  CredentialsError,
  fingerprint,
  isWellFormedKey,
  mintKey,
  readMachineMetadata,
  resolveMachineKey,
} from './credentials-file.js';

let dir: string;
let file: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ABX_CREDENTIALS_FILE: file, ...extra };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abx-creds-'));
  file = path.join(dir, 'actual_budget.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mintKey', () => {
  it('produces 64 hex characters from a CSPRNG', () => {
    const key = mintKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(isWellFormedKey(key)).toBe(true);
    // Not a UUID, not a timestamp, not a hash of the hostname (R1).
    expect(key).not.toBe(mintKey());
  });
});

describe('fingerprint', () => {
  it('never contains the key', () => {
    const key = mintKey();
    const fp = fingerprint(key);
    expect(fp).not.toContain(key);
    expect(fp).toContain(key.slice(0, 4));
    // Two holders of the same key agree without exchanging one (R2).
    expect(fingerprint(key)).toBe(fp);
  });
});

describe('resolveMachineKey', () => {
  it('returns null rather than minting when mint is off', () => {
    expect(resolveMachineKey({ env: env(), mint: false })).toBeNull();
  });

  it('mints a 0600 file with 0700 parent on first run', () => {
    const resolved = resolveMachineKey({ env: env(), mint: true });

    expect(resolved?.source).toBe('minted');
    expect(isWellFormedKey(resolved?.key ?? '')).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it('reads the existing key back rather than minting a second one', () => {
    const first = resolveMachineKey({ env: env(), mint: true });
    const second = resolveMachineKey({ env: env(), mint: true });

    expect(second?.key).toBe(first?.key);
    expect(second?.source).toBe('credentials-file');
  });

  it("PRESERVES another product's secrets when it writes", () => {
    // Three unrelated products may share ~/.credentials/. A writer that
    // serialises the file whole from memory is the one program most likely to
    // delete somebody else's Google client secret at 2am (§4.3).
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        google_drive: { refresh_token: 'keep-me' },
        actual_budget: { statements: { root: '/somewhere' } },
      }),
      { mode: 0o600 },
    );

    resolveMachineKey({ env: env(), mint: true });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.google_drive.refresh_token).toBe('keep-me');
    expect(after.actual_budget.statements.root).toBe('/somewhere');
    expect(isWellFormedKey(after.actual_budget.machine.api_key)).toBe(true);
  });

  it('records provenance so a key found in six months can be explained', () => {
    resolveMachineKey({
      env: env(),
      mint: true,
      mintedBy: 'abx',
      label: 'test-tower',
    });

    const meta = readMachineMetadata(env());
    expect(meta?.created_by).toBe('abx');
    expect(meta?.label).toBe('test-tower');
    expect(Date.parse(meta?.created ?? '')).not.toBeNaN();
  });

  it('prefers the environment over the file', () => {
    resolveMachineKey({ env: env(), mint: true });
    const inline = mintKey();

    const resolved = resolveMachineKey({
      env: env({ ABX_MACHINE_KEY: inline }),
      mint: true,
    });

    expect(resolved?.key).toBe(inline);
    expect(resolved?.source).toBe('env');
  });

  it('reads a key out of ABX_MACHINE_KEY_FILE — the Docker-secret shape', () => {
    const keyFile = path.join(dir, 'secret');
    const key = mintKey();
    fs.writeFileSync(keyFile, `${key}\n`);

    const resolved = resolveMachineKey({
      env: env({ ABX_MACHINE_KEY_FILE: keyFile }),
      mint: false,
    });

    expect(resolved?.key).toBe(key);
    expect(resolved?.source).toBe('env-file');
  });

  it('refuses a malformed key instead of sending it and getting a 401', () => {
    expect(() =>
      resolveMachineKey({ env: env({ ABX_MACHINE_KEY: 'nope' }), mint: false }),
    ).toThrow(CredentialsError);
  });
});

describe('assertSafeMode', () => {
  it('refuses a world-readable file and names the chmod', () => {
    resolveMachineKey({ env: env(), mint: true });
    fs.chmodSync(file, 0o644);

    try {
      assertSafeMode(file);
      expect.unreachable('should have refused a 0644 credentials file');
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialsError);
      expect((err as CredentialsError).fix).toBe(`chmod 600 ${file}`);
    }
  });

  it('refuses a symlink rather than following it to a well-moded target', () => {
    const real = path.join(dir, 'real.json');
    fs.writeFileSync(real, '{}', { mode: 0o600 });
    const link = path.join(dir, 'link.json');
    fs.symlinkSync(real, link);

    expect(() => assertSafeMode(link)).toThrow(CredentialsError);
  });

  it('accepts a correctly-moded file', () => {
    resolveMachineKey({ env: env(), mint: true });
    expect(() => assertSafeMode(file)).not.toThrow();
  });
});
