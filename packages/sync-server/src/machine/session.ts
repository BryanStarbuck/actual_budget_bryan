/**
 * The engine's session with the sync server it lives inside — pm/apis.mdx §3.1, §8.1.
 *
 * The engine is a second `@actual-app/api` instance with its own data
 * directory. Left alone it is an island: a budget it creates never reaches
 * the browser at :3001, because the browser only sees what the sync server
 * holds. So the engine is joined to the sync server as a client — the same
 * way the browser is — and syncs through it.
 *
 * A client needs a session token. The browser gets one by posting the
 * operator's password to /account/login. THIS process IS the sync server, and
 * the sessions table is a file it already holds open, so it mints its own row
 * directly and no password is ever typed, stored, or sent for the engine's
 * benefit. That is not a bypass of the server's authentication: a process
 * that can write account.sqlite has already passed every gate that file
 * guards.
 *
 * The row is tagged auth_method = 'machine' so it is distinguishable from the
 * password session the browser reuses, never expires (the machine key in
 * front of the plane is the credential that can be rotated), and is created
 * at most once.
 *
 * Nothing here runs until the server has been bootstrapped — a server with no
 * owner has no user for a session to belong to. In that state the engine
 * starts local-only and /health says so with the remediation.
 */
import { randomUUID } from 'node:crypto';

import { errorFileFor } from '@actual-app/error-file';

import { getAccountDb, needsBootstrap } from '#account-db';
import { config } from '#load-config';
import { TOKEN_EXPIRATION_NEVER } from '#util/validate-user';

const errors = errorFileFor('sync-server/src/machine/session.ts');

const MACHINE_AUTH_METHOD = 'machine';

export type EngineSession = {
  serverURL: string;
  sessionToken: string;
};

/** The sync server's own loopback URL, from its own config — never guessed. */
export function ownServerURL(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ACTUAL_MACHINE_SERVER_URL) {
    return env.ACTUAL_MACHINE_SERVER_URL;
  }
  const port = config.get('port');
  return `http://127.0.0.1:${port}`;
}

/**
 * Mint (or reuse) the engine's session. Null when the server is not yet
 * bootstrapped, which the caller reports rather than hides.
 */
export function engineSession(
  env: NodeJS.ProcessEnv = process.env,
): EngineSession | null {
  if (env.ACTUAL_MACHINE_SESSION_TOKEN) {
    return {
      serverURL: ownServerURL(env),
      sessionToken: env.ACTUAL_MACHINE_SESSION_TOKEN,
    };
  }

  let db: ReturnType<typeof getAccountDb>;
  try {
    if (needsBootstrap()) {
      return null;
    }
    db = getAccountDb();
  } catch (err) {
    errors.caught('opening the account database for the engine session', err);
    return null;
  }

  const existing = db.first(
    'SELECT token FROM sessions WHERE auth_method = ? LIMIT 1',
    [MACHINE_AUTH_METHOD],
  ) as { token: string } | undefined;
  if (existing?.token) {
    return { serverURL: ownServerURL(env), sessionToken: existing.token };
  }

  // The owner: the row bootstrap creates. Multi-user installs may have more
  // than one user; the engine acts as the owner, who can open every file.
  const owner = db.first(
    'SELECT id FROM users WHERE owner = 1 AND enabled = 1 ORDER BY id LIMIT 1',
  ) as { id: string } | undefined;
  if (!owner?.id) {
    return null;
  }

  const token = randomUUID();
  db.mutate(
    'INSERT INTO sessions (token, expires_at, user_id, auth_method) VALUES (?, ?, ?, ?)',
    [token, TOKEN_EXPIRATION_NEVER, owner.id, MACHINE_AUTH_METHOD],
  );
  return { serverURL: ownServerURL(env), sessionToken: token };
}
