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
import { out, render } from '../render.js';
import type { Row } from '../render.js';
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

/**
 * `abx whoami` — pm/apis.mdx §8.0.
 *
 * The first thing to run when an answer looks wrong. Nine times in ten the
 * cause is a different budget or a different install, and both are in here.
 */
export const whoami: Verb = {
  name: 'whoami',
  summary: 'which install, which budget, which tiers, which key',
  async run(ctx): Promise<number> {
    const envelope = await call(ctx.target, ctx.requireKey(), '/whoami', {
      timeoutMs: 10_000,
      logger: ctx.logger,
      verb: 'whoami',
    });

    const d = (envelope as { data: WhoamiData }).data;
    const rows: Row[] = [
      { field: 'target', value: d.target },
      { field: 'server', value: d.serverVersion },
      { field: 'key', value: d.keyFingerprint },
      {
        field: 'budget',
        value: d.budget ? `${d.budget.name} (${d.budget.id})` : '(none open)',
      },
      { field: 'engine', value: d.engine.status },
      { field: 'data dir', value: d.engine.dataDir },
      { field: 'write tier', value: d.tiers.write ? 'ENABLED' : 'off' },
      { field: 'admin tier', value: d.tiers.admin ? 'ENABLED' : 'off' },
      { field: 'statements', value: d.statementsRoot ?? '(not configured)' },
    ];

    out(
      render(ctx.format, envelope, rows, [
        { key: 'field', header: 'FIELD' },
        { key: 'value', header: 'VALUE' },
      ]),
    );
    return Exit.ok;
  },
};

type WhoamiData = {
  target: string;
  serverVersion: string;
  keyFingerprint: string;
  tiers: { read: boolean; write: boolean; admin: boolean };
  engine: { status: string; dataDir: string };
  budget: { id: string; name: string } | null;
  statementsRoot: string | null;
};

/**
 * `abx capabilities` — pm/apis.mdx §6.3.
 *
 * What THIS server build can do. It exists so that a verb the server does not
 * have yet is a sentence rather than a 404 the operator has to decode, and so
 * a `planned` route cannot be mistaken for a working one.
 */
export const capabilities: Verb = {
  name: 'capabilities',
  summary: 'the route table, tiers and limits of this server build',
  async run(ctx): Promise<number> {
    const envelope = await call(ctx.target, ctx.requireKey(), '/capabilities', {
      timeoutMs: 10_000,
      logger: ctx.logger,
      verb: 'capabilities',
    });

    const d = (envelope as { data: CapabilitiesData }).data;
    const rows: Row[] = d.routes.flatMap(r =>
      r.methods.map(m => ({
        method: m,
        path: r.path,
        tier: r.tier[m],
        status: r.status[m],
        summary: r.summary[m],
      })),
    );

    out(
      render(ctx.format, envelope, rows, [
        { key: 'method', header: 'METHOD' },
        { key: 'path', header: 'PATH' },
        { key: 'tier', header: 'TIER' },
        { key: 'status', header: 'STATUS' },
        { key: 'summary', header: 'SUMMARY' },
      ]),
    );
    return Exit.ok;
  },
};

type CapabilitiesData = {
  routes: Array<{
    path: string;
    methods: string[];
    tier: Record<string, string>;
    status: Record<string, string>;
    summary: Record<string, string>;
  }>;
};

/**
 * `abx health` — pm/apis.mdx §8.0.
 *
 * `--probe` starts the engine rather than only reporting that it has not
 * started. Off by default, because the plain check must not depend on the
 * thing it is checking.
 *
 * Exit code 1 when unhealthy, so this is usable in a shell conditional — the
 * whole point of a health verb.
 */
export const health: Verb = {
  name: 'health',
  summary: 'can the plane actually answer a question about a budget?',
  flags: {
    probe: {
      arity: 'boolean',
      help: 'start the engine and report the result, instead of only reporting that it has not started',
    },
  },
  async run(ctx): Promise<number> {
    const probe = getBoolean(ctx.args, 'probe');
    const envelope = await call(
      ctx.target,
      ctx.requireKey(),
      probe ? '/health?probe=true' : '/health',
      {
        // A probe initialises the engine, which opens a database and runs
        // migrations. That is not a 10-second operation on a cold budget.
        timeoutMs: probe ? 120_000 : 10_000,
        logger: ctx.logger,
        verb: 'health',
      },
    );

    const d = (envelope as { data: HealthData }).data;
    const rows: Row[] = [
      { field: 'healthy', value: d.healthy ? 'yes' : 'NO' },
      { field: 'engine', value: d.engine.status },
      {
        field: 'budget',
        value: d.budget ? `${d.budget.name} (${d.budget.id})` : '(none open)',
      },
      { field: 'known budgets', value: String(d.knownBudgets.length) },
      ...(d.hint ? [{ field: 'next step', value: d.hint }] : []),
    ];

    out(
      render(ctx.format, envelope, rows, [
        { key: 'field', header: 'FIELD' },
        { key: 'value', header: 'VALUE' },
      ]),
    );
    return d.healthy ? Exit.ok : Exit.failed;
  },
};

type HealthData = {
  healthy: boolean;
  engine: { status: string; dataDir: string; error?: string };
  budget: { id: string; name: string } | null;
  knownBudgets: Array<{ id: string; name: string }>;
  hint: string | null;
};

/** Exposed for `abx up`'s failure path, which prints the tail of server.log. */
export { serverPidPath };
