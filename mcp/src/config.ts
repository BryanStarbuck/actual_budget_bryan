/**
 * Configuration — pm/mcp.mdx §14.
 *
 * Every variable is read ONCE at startup into a frozen object. A setting that
 * can change mid-session is a setting that explains a bug badly: the operator
 * reports what the server did, you read the env, and the two do not match
 * because something rewrote process.env between the two.
 */
import os from 'node:os';
import path from 'node:path';

export type Target = 'local' | 'remote';

export type Config = Readonly<{
  apiUrl: string;
  target: Target;
  allowWrite: boolean;
  allowRemote: boolean;
  maxChanges: number;
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logDir: string;
  credentialsFile: string;
}>;

export class ConfigError extends Error {
  readonly fix: string;

  constructor(message: string, fix: string) {
    super(message);
    this.name = 'ConfigError';
    this.fix = fix;
  }
}

const DEFAULT_API_URL = 'http://127.0.0.1:5006';

function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') {
    return true;
  }
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(
      `${name} must be a positive integer, got "${raw}".`,
      `unset ${name} or set it to a number`,
    );
  }
  return Number(raw);
}

function logLevel(raw: string | undefined): Config['logLevel'] {
  if (raw === undefined) {
    return 'info';
  }
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw;
  }
  throw new ConfigError(
    `ABMCP_LOG_LEVEL must be error, warn, info or debug, got "${raw}".`,
    'unset ABMCP_LOG_LEVEL',
  );
}

/**
 * Resolve config, or throw. Called before the transport is attached, so a
 * misconfiguration is a clean refusal on stderr rather than a server that
 * connects and then 500s on every call (§15).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiUrl = env.ABMCP_API_URL ?? DEFAULT_API_URL;

  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new ConfigError(
      `ABMCP_API_URL is not a URL: "${apiUrl}".`,
      'unset it to use the default http://127.0.0.1:5006',
    );
  }

  const loopback = isLoopbackHost(url.hostname);
  const allowRemote = env.ABMCP_ALLOW_REMOTE === '1';

  // §7.3 — the production tripwire. A non-loopback URL is somebody's server,
  // and reaching it by accident is how a model answers about the wrong ledger
  // with total confidence.
  if (!loopback) {
    if (!allowRemote) {
      throw new ConfigError(
        `ABMCP_API_URL points at ${url.host}, which is not this machine.`,
        'set ABMCP_ALLOW_REMOTE=1 if that is deliberate — it also forces https: and disables writes',
      );
    }
    if (url.protocol !== 'https:') {
      throw new ConfigError(
        `Refusing to send the machine key to ${apiUrl} in cleartext.`,
        'use https: for a remote target',
      );
    }
  }

  const target: Target = loopback ? 'local' : 'remote';

  // A remote install is READ-ONLY from here, full stop — even with both write
  // switches on. Writing to somebody else's budget over a tunnel is not a
  // thing this server does.
  const allowWrite = env.ABMCP_ALLOW_WRITE === '1' && target === 'local';

  return Object.freeze({
    apiUrl: url.origin,
    target,
    allowWrite,
    allowRemote,
    maxChanges: positiveInt(env.ABMCP_MAX_CHANGES, 200, 'ABMCP_MAX_CHANGES'),
    maxRows: positiveInt(env.ABMCP_MAX_ROWS, 1000, 'ABMCP_MAX_ROWS'),
    maxBytes: positiveInt(env.ABMCP_MAX_BYTES, 1048576, 'ABMCP_MAX_BYTES'),
    timeoutMs: positiveInt(env.ABMCP_TIMEOUT_MS, 30000, 'ABMCP_TIMEOUT_MS'),
    logLevel: logLevel(env.ABMCP_LOG_LEVEL),
    logDir: env.ABMCP_LOG_DIR ?? path.join(os.homedir(), 'T', '_actual_budget'),
    credentialsFile:
      env.ABMCP_CREDENTIALS_FILE ??
      env.ABX_CREDENTIALS_FILE ??
      path.join(os.homedir(), '.credentials', 'actual_budget.json'),
  });
}
