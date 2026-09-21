/**
 * Bring-up — pm/cli.mdx §3.
 *
 * `abx` never says "start the server first." If the app is down it brings it
 * up and then answers the question.
 *
 * The trap this module exists to avoid is named in §3.2 and inherited from
 * Large File Bridge, which lost an afternoon to it: FRONTEND UP != APP UP.
 * Vite serves pages happily with nothing behind it, so a CLI that gated on
 * :3001 answering HTTP would report success while every call 404s. The gate
 * is :5006/health and nothing else.
 *
 * What the root justfile does NOT give us (§3.1): its `server` recipe runs in
 * the foreground and writes no log, `server.pid` does not exist, and its
 * port-holder refusal guards :3001 rather than :5006. So this module owns
 * the detached start, server.log, server.pid and the :5006 guard.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { CliError, Exit } from './exit.js';
import { stateDir } from './logger.js';
import type { Spinner } from './progress.js';
import { errorFileFor } from './vendor/error-file/index.ts';

const errors = errorFileFor('cli/code/src/bringup.ts');

const DEFAULT_PORT = 5006;

/**
 * The port of the install we are aimed at.
 *
 * Derived from the base URL rather than hard-coded, because every other use of
 * a port here is a REFUSAL or a KILL. Checking 5006 while talking to 5099
 * would mean refusing to start because of a process that has nothing to do
 * with our target, or — worse, in stopServer — signalling one.
 */
export function portOf(baseUrl: string): number {
  try {
    const port = new URL(baseUrl).port;
    return port === '' ? DEFAULT_PORT : Number(port);
  } catch (e) {
    errors.expected('parsing the target base URL', e);
    return DEFAULT_PORT;
  }
}

const HEALTH_TIMEOUT_MS = 2_000;
const BRINGUP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export function serverLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'server.log');
}

export function serverPidPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'server.pid');
}

/** `{"status":"UP"}` from :5006/health — the only gate (§3.2). */
export async function probeHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: string };
    return body.status === 'UP';
  } catch (e) {
    // A probe: the app being down is the question, not a fault.
    errors.expected('probing the sync server health', e);
    return false;
  }
}

export type PortHolder = { pid: number; command: string };

/**
 * Who holds a port, if anyone.
 *
 * Used to REFUSE, never to kill: the pid on 5006 might be something the
 * operator cares about, and a task runner that blanket-kills a port is a task
 * runner nobody trusts twice.
 */
export function portHolder(port: number): PortHolder | null {
  try {
    const out = execFileSync(
      'lsof',
      ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();

    const pid = Number(out.split('\n')[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }

    let command = 'unknown';
    try {
      command = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (e) {
      // A pid we cannot name is still a pid we must not kill.
      errors.expected('naming the process holding the port', e);
    }

    return { pid, command };
  } catch (e) {
    // lsof exits non-zero when nothing holds the port.
    errors.expected('finding the holder of the port', e);
    return null;
  }
}

/** Is this pid one we started and recorded? */
function ourRecordedPid(env: NodeJS.ProcessEnv): number | null {
  try {
    const raw = fs.readFileSync(serverPidPath(env), 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    process.kill(pid, 0);
    return pid;
  } catch (e) {
    // No pid file, or the recorded process is gone: both mean "not ours".
    errors.expected('reading the recorded server pid', e);
    return null;
  }
}

export type BringUpOptions = {
  baseUrl: string;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  spinner?: Spinner;
  /** --no-bringup: report the app is down rather than starting it. */
  allowed: boolean;
};

/**
 * Ensure the sync server is up, starting it if it is not.
 *
 * Returns true if it was already up, so callers can report honestly.
 */
export async function ensureServerUp(opts: BringUpOptions): Promise<boolean> {
  const env = opts.env ?? process.env;

  if (await probeHealth(opts.baseUrl)) {
    return true;
  }

  if (!opts.allowed) {
    throw new CliError(Exit.unreachable, 'The app is not running.', {
      hint: 'abx up  (or drop --no-bringup)',
    });
  }

  // Only refuse a FOREIGN holder. Our own recorded pid holding the port while
  // /health is not yet answering just means it is still booting.
  const port = portOf(opts.baseUrl);
  const holder = portHolder(port);
  const ours = ourRecordedPid(env);
  if (holder !== null && holder.pid !== ours) {
    throw new CliError(
      Exit.unreachable,
      `Port ${port} is held by pid ${holder.pid} (${holder.command}), which we did not start.`,
      {
        hint: `free it yourself (kill ${holder.pid}) and retry — abx will not kill a process it does not own`,
      },
    );
  }

  // Only now is there something to wait for, so only now does the spinner
  // start. The up-to-120s /health wait is exactly where an operator assumes a
  // hang, which is the whole reason §12 exists.
  opts.spinner?.start('Starting the sync server');

  if (holder === null) {
    startDetached(opts.repoRoot, env);
  }

  const deadline = Date.now() + BRINGUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probeHealth(opts.baseUrl)) {
      return false;
    }
    opts.spinner?.tick('Waiting for the sync server');
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new CliError(
    Exit.unreachable,
    `The sync server did not answer ${opts.baseUrl}/health within 120s.`,
    { hint: `tail ${serverLogPath(env)}`, detail: tailLog(env, 30) },
  );
}

/**
 * Start the sync server detached, with output appended to server.log.
 *
 * Detached + unref'd so the server outlives this CLI invocation — an operator
 * running `abx accounts list` expects the app to still be up afterwards.
 * Output goes to the state root, never /tmp (§15).
 */
function startDetached(repoRoot: string, env: NodeJS.ProcessEnv): void {
  const dir = stateDir(env);
  fs.mkdirSync(dir, { recursive: true });

  // Budget data must never land inside the repo: the sync server defaults
  // ACTUAL_DATA_DIR to its cwd. Same location as the justfile's `data`.
  const dataDir = env.ACTUAL_DATA_DIR ?? path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const log = fs.openSync(serverLogPath(env), 'a');
  try {
    const child = spawn('yarn', ['start:server'], {
      cwd: repoRoot,
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...env, ACTUAL_DATA_DIR: dataDir },
    });
    child.unref();

    if (child.pid !== undefined) {
      fs.writeFileSync(serverPidPath(env), `${child.pid}\n`);
    }
  } finally {
    fs.closeSync(log);
  }
}

export function tailLog(env: NodeJS.ProcessEnv, lines: number): string {
  try {
    const contents = fs.readFileSync(serverLogPath(env), 'utf8');
    return contents.split('\n').slice(-lines).join('\n');
  } catch (e) {
    errors.expected('reading the optional server.log', e);
    return '(no server.log yet)';
  }
}

/**
 * Stop OUR instance — the recorded pid tree, then a node process on the
 * target's port. Never a foreign process (§3.3).
 */
export function stopServer(
  env: NodeJS.ProcessEnv = process.env,
  baseUrl = `http://127.0.0.1:${DEFAULT_PORT}`,
): 'stopped' | 'not-running' | 'foreign' {
  const pid = ourRecordedPid(env);
  if (pid !== null) {
    try {
      // Negative pid kills the process group, which is what `detached: true`
      // gave us — the server spawns children and killing only the parent
      // leaves them holding the port.
      process.kill(-pid, 'SIGTERM');
    } catch (e) {
      errors.expected('signalling the server process group', e);
      try {
        process.kill(pid, 'SIGTERM');
      } catch (inner) {
        // Already gone.
        errors.expected('signalling the server process', inner);
      }
    }
    try {
      fs.unlinkSync(serverPidPath(env));
    } catch (e) {
      // Nothing to clean up.
      errors.expected('removing the server pid file', e);
    }
    return 'stopped';
  }

  const holder = portHolder(portOf(baseUrl));
  if (holder === null) {
    return 'not-running';
  }
  if (!holder.command.includes('node')) {
    return 'foreign';
  }
  try {
    process.kill(holder.pid, 'SIGTERM');
    return 'stopped';
  } catch (e) {
    errors.expected('signalling the process on the port', e);
    return 'foreign';
  }
}
