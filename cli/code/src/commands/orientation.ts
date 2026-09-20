/**
 * Orientation verbs — pm/cli.mdx §3.3, §8, §11.
 *
 * These are the verbs an operator reaches for when something is wrong, so
 * every one of them is written to work when things ARE wrong: bare `abx`
 * never fails because the server is down, and `doctor` separates "is my
 * environment sane" from "is the app running" because the two have completely
 * different fixes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getBoolean, getNumber } from '../args.js';
import {
  ensureServerUp,
  portHolder,
  probeHealth,
  serverLogPath,
  serverPidPath,
  stopServer,
  tailLog,
} from '../bringup.js';
import { call } from '../client.js';
import {
  assertSafeMode,
  credentialsPath,
  fingerprint,
  readMachineMetadata,
  resolveMachineKey,
} from '../credentials.js';
import { Exit } from '../exit.js';
import { stateDir } from '../logger.js';
import { withSpinner } from '../progress.js';
import { out } from '../render.js';
import type { Context, Verb } from '../verb.js';

const WEB_URL = 'http://localhost:3001/';

/** The port of the install we are actually aimed at, not a constant. */
function targetPort(ctx: Context): number {
  const port = new URL(ctx.target.baseUrl).port;
  return port === '' ? 5006 : Number(port);
}

type Check = {
  label: string;
  required: boolean;
  ok: boolean;
  detail: string;
};

async function machinePlaneStatus(ctx: Context): Promise<{
  state: 'ok' | 'unauthorized' | 'absent' | 'down';
  detail: string;
}> {
  if (!(await probeHealth(ctx.target.baseUrl))) {
    return {
      state: 'down',
      detail: 'the sync server is not answering /health',
    };
  }
  try {
    const key = ctx.requireKey();
    await call(ctx.target, key, '/ping', {
      timeoutMs: 5_000,
      logger: ctx.logger,
      verb: 'status',
    });
    return { state: 'ok', detail: 'mounted, key accepted' };
  } catch (err) {
    const code = (err as { code?: number }).code;
    if (code === Exit.unauthorized) {
      // A green /health with a 401 from ping is the single most likely
      // first-run failure, and it needs a message of its own (§3.2).
      return {
        state: 'unauthorized',
        detail: 'the server is holding a different key — restart it',
      };
    }
    if (code === Exit.notFound) {
      return {
        state: 'absent',
        detail: 'the plane is not mounted — the server booted without a key',
      };
    }
    return { state: 'down', detail: (err as Error).message };
  }
}

/**
 * Bare `abx` — the zero-argument default (§8).
 *
 * It NEVER starts the app: bare `abx` is a question, not an instruction. And
 * it never fails because something is down — a down server, a missing key and
 * an unconfigured statements root each print as a line with the command that
 * fixes them.
 */
export const orient: Verb = {
  name: '',
  summary: 'status of this install, and what to do next',
  local: true,
  async run(ctx): Promise<number> {
    const lines: string[] = ['Actual Budget — this machine'];

    const web = portHolder(3001);
    lines.push(
      `  web          ${WEB_URL.padEnd(24)} ${web === null ? 'down' : `UP    (pid ${web.pid})`}`,
    );

    const healthy = await probeHealth(ctx.target.baseUrl);
    const server = portHolder(targetPort(ctx));
    lines.push(
      `  sync server  ${`${ctx.target.baseUrl}/`.padEnd(24)} ${
        healthy ? `UP    (pid ${server?.pid ?? '?'})` : 'down'
      }`,
    );

    const file = credentialsPath(ctx.env);
    let keyLine = `  machine key  ${file}   missing`;
    try {
      const meta = readMachineMetadata(ctx.env);
      if (meta?.api_key !== undefined) {
        assertSafeMode(file);
        keyLine = `  machine key  ${file}   ok   (${fingerprint(meta.api_key)})`;
      }
    } catch (err) {
      keyLine = `  machine key  ${file}   REFUSED: ${(err as Error).message}`;
    }
    lines.push(keyLine);

    if (healthy) {
      const plane = await machinePlaneStatus(ctx);
      lines.push(`  machine plane  ${plane.state} — ${plane.detail}`);
    }

    lines.push('');
    if (!healthy) {
      lines.push('  abx up                  start the app');
    }
    lines.push('  abx doctor              check the environment');
    lines.push('  abx accounts list       the accounts');

    out(lines.join('\n'));
    return Exit.ok;
  },
};

export const doctor: Verb = {
  name: 'doctor',
  summary: 'is this environment sane?',
  local: true,
  async run(ctx): Promise<number> {
    const checks: Check[] = [];

    const major = Number(process.versions.node.split('.')[0]);
    checks.push({
      label: 'Node >= 22',
      required: true,
      ok: major >= 22,
      detail: process.version,
    });

    const dir = stateDir(ctx.env);
    let writable = false;
    let stateDetail = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      writable = true;
    } catch (err) {
      stateDetail = `${dir} — ${(err as Error).message}`;
    }
    checks.push({
      label: 'state dir writable',
      required: true,
      ok: writable,
      detail: stateDetail,
    });

    const file = credentialsPath(ctx.env);
    let credentialsOk = false;
    let credentialsDetail = `${file} — missing (abx key init mints it)`;
    try {
      if (fs.existsSync(file)) {
        assertSafeMode(file);
        const meta = readMachineMetadata(ctx.env);
        credentialsOk = meta?.api_key !== undefined;
        credentialsDetail = credentialsOk
          ? `${file} — 0600, ${fingerprint(meta?.api_key ?? '')}`
          : `${file} — present but holds no machine key`;
      }
    } catch (err) {
      credentialsDetail = `${file} — ${(err as Error).message}`;
    }
    checks.push({
      label: 'credentials file 0600 and ours',
      required: true,
      ok: credentialsOk,
      detail: credentialsDetail,
    });

    // Deliberately NOT required: "is my environment sane" and "is the server
    // up" are different questions with different fixes (§11.1).
    const healthy = await probeHealth(ctx.target.baseUrl);
    checks.push({
      label: `:${targetPort(ctx)} /health`,
      required: false,
      ok: healthy,
      detail: healthy ? 'UP' : 'down — abx up',
    });

    if (healthy) {
      const plane = await machinePlaneStatus(ctx);
      checks.push({
        label: '/machine/v1/ping',
        required: false,
        ok: plane.state === 'ok',
        detail: plane.detail,
      });
    }

    const web = portHolder(3001);
    checks.push({
      label: ':3001 holder',
      required: false,
      ok: true,
      detail: web === null ? 'free' : `pid ${web.pid} (${web.command})`,
    });

    const lines = checks.map(check => {
      const mark = check.ok ? 'ok  ' : check.required ? 'FAIL' : 'warn';
      return `  ${mark}  ${check.label.padEnd(34)} ${check.detail}`;
    });
    out(['abx doctor', ...lines].join('\n'));

    return checks.some(check => check.required && !check.ok)
      ? Exit.failed
      : Exit.ok;
  },
};

export const up: Verb = {
  name: 'up',
  summary: 'bring the app up and wait for health',
  local: true,
  async run(ctx): Promise<number> {
    const already = await withSpinner({ quiet: ctx.quiet }, spinner =>
      ensureServerUp({
        baseUrl: ctx.target.baseUrl,
        repoRoot: ctx.repoRoot,
        env: ctx.env,
        spinner,
        allowed: true,
      }),
    );

    out(
      already
        ? `already up — ${ctx.target.baseUrl}`
        : `up — ${ctx.target.baseUrl}  (log: ${serverLogPath(ctx.env)})`,
    );
    return Exit.ok;
  },
};

export const stop: Verb = {
  name: 'stop',
  summary: 'stop our instance of the app',
  local: true,
  async run(ctx): Promise<number> {
    const result = stopServer(ctx.env, ctx.target.baseUrl);
    switch (result) {
      case 'stopped':
        out('stopped');
        return Exit.ok;
      case 'not-running':
        out('not running');
        return Exit.ok;
      case 'foreign':
        // Never kill something we did not start.
        out(
          `left the process on :${targetPort(ctx)} alone — we did not start it`,
        );
        return Exit.failed;

      default:
        // stopServer() returns a closed union; a new outcome added without a
        // branch here would otherwise fall through and report success.
        out(`unexpected stop result: ${String(result)}`);
        return Exit.failed;
    }
  },
};

export const status: Verb = {
  name: 'status',
  summary: 'ports, health, machine-plane ping, key fingerprint',
  local: true,
  async run(ctx): Promise<number> {
    const lines: string[] = [];

    // Report the port we are ACTUALLY talking to, not a hard-coded 5006.
    // With `--api http://127.0.0.1:5099`, printing ":5006 free" beside a
    // healthy machine plane is the §7.2 failure in miniature: a report that
    // looks like success against an install it never touched.
    for (const [label, port] of [
      ['web', 3001],
      ['sync-server', targetPort(ctx)],
    ] as const) {
      const holder = portHolder(port);
      lines.push(
        holder === null
          ? `${label}: down  (:${port} free)`
          : `${label}: UP    http://localhost:${port}/   (pid ${holder.pid})`,
      );
    }

    if (ctx.target.kind === 'explicit') {
      lines.push(
        `target: ${ctx.target.baseUrl}  (--api, not this machine's default install)`,
      );
    }

    const plane = await machinePlaneStatus(ctx);
    lines.push(`machine plane: ${plane.state} — ${plane.detail}`);

    const meta = readMachineMetadata(ctx.env);
    lines.push(
      `machine key: ${
        meta?.api_key === undefined ? 'missing' : fingerprint(meta.api_key)
      }`,
    );

    out(lines.join('\n'));
    return Exit.ok;
  },
};

export const logs: Verb = {
  name: 'logs',
  summary: 'tail the app logs',
  local: true,
  flags: {
    lines: { arity: 'number', help: 'how many lines to show (default: 40)' },
    follow: { arity: 'boolean', help: 'keep printing as the log grows' },
  },
  async run(ctx): Promise<number> {
    const lines = getNumber(ctx.args, 'lines') ?? 40;
    const dev = path.join(stateDir(ctx.env), 'dev.log');
    const server = serverLogPath(ctx.env);

    // Paths first, so an operator can leave and open them in an editor.
    process.stderr.write(`dev:    ${dev}\nserver: ${server}\n\n`);
    out(tailLog(ctx.env, lines));

    if (getBoolean(ctx.args, 'follow')) {
      process.stderr.write(
        '--follow is not implemented yet; use: tail -f ' + server + '\n',
      );
    }
    return Exit.ok;
  },
};

export const key: Verb = {
  name: 'key',
  summary: 'the machine key — init | show | rotate --yes',
  positionals: ['<init|show|rotate>'],
  local: true,
  async run(ctx): Promise<number> {
    const action = ctx.args.positionals[0] ?? 'show';
    const file = credentialsPath(ctx.env);

    switch (action) {
      case 'init': {
        const resolved = resolveMachineKey({
          env: ctx.env,
          mint: true,
          mintedBy: 'abx',
          label: os.hostname(),
        });
        out(
          `${resolved?.source === 'minted' ? 'minted' : 'already present'}  ${file}  ${fingerprint(
            resolved?.key ?? '',
          )}`,
        );
        return Exit.ok;
      }

      case 'show': {
        // R2 — the fingerprint, never the key.
        const meta = readMachineMetadata(ctx.env);
        if (meta?.api_key === undefined) {
          out(`no machine key in ${file}`);
          return Exit.notFound;
        }
        assertSafeMode(file);
        const stat = fs.statSync(file);
        out(
          [
            `path        ${file}`,
            `mode        ${(stat.mode & 0o777).toString(8).padStart(3, '0')}`,
            `owner       uid ${stat.uid}`,
            `fingerprint ${fingerprint(meta.api_key)}`,
            `created     ${meta.created ?? 'unknown'}`,
            `created_by  ${meta.created_by ?? 'unknown'}`,
            `label       ${meta.label ?? '—'}`,
          ].join('\n'),
        );
        return Exit.ok;
      }

      case 'rotate': {
        // R4 — never implicitly. A rotation that happened as a side effect of
        // an ordinary verb would break the MCP silently.
        if (!getBoolean(ctx.args, 'yes')) {
          out(
            'abx key rotate needs --yes. The sync server must be restarted afterwards.',
          );
          return Exit.usage;
        }
        const current = readMachineMetadata(ctx.env);
        if (current?.api_key !== undefined) {
          const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
            string,
            unknown
          >;
          const product = doc.actual_budget as
            | { machine?: unknown }
            | undefined;
          if (product !== undefined) {
            delete product.machine;
          }
          fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, {
            mode: 0o600,
          });
        }
        const rotated = resolveMachineKey({
          env: ctx.env,
          mint: true,
          mintedBy: 'abx',
          label: os.hostname(),
        });
        out(
          `rotated — ${fingerprint(rotated?.key ?? '')}\nrestart the server so it reloads: abx stop && abx up`,
        );
        return Exit.ok;
      }

      default:
        out(`abx key <init|show|rotate --yes>, got "${action}"`);
        return Exit.usage;
    }
  },
};

export const ping: Verb = {
  name: 'ping',
  summary: 'liveness + key check against the machine plane',
  async run(ctx): Promise<number> {
    const envelope = await call(ctx.target, ctx.requireKey(), '/ping', {
      timeoutMs: 10_000,
      logger: ctx.logger,
      verb: 'ping',
    });
    out(JSON.stringify(envelope, null, 2));
    return Exit.ok;
  },
};

/** Exposed for `abx up`'s failure path, which prints the tail of server.log. */
export { serverPidPath };
