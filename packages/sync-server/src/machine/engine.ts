/**
 * The engine — pm/apis.mdx §3.1, §15.
 *
 * ONE initialised `@actual-app/api` instance for the process lifetime. It is
 * the same engine the browser drives, which is the whole point: the web UI,
 * `abx` and the MCP answer from one place and cannot disagree about a balance
 * (§2 R1, §15).
 *
 * THREE DECISIONS HERE ARE LOAD-BEARING, and each one is a bug if reversed:
 *
 *   1. `@actual-app/api` is reached by DYNAMIC import, and it is a
 *      devDependency rather than a dependency of this package.
 *
 *      `@actual-app/sync-server` is published. Adding a runtime dependency to
 *      it changes the dependency graph of an upstream artefact, which is
 *      exactly the merge friction §3.1 exists to avoid — the entire delta to
 *      upstream's tree is meant to be one `app.use()` and one
 *      `initMachinePlane()`. A dynamic import keeps the module out of the
 *      bundle (vite leaves everything but `@actual-app/crdt` external) and
 *      turns "not installed" into a clean `not_ready` instead of a boot
 *      failure. A production `yarn install:server` has no devDependencies, so
 *      the plane there reports the engine as unavailable and says why — which
 *      is R9, fail closed, not a degraded mode.
 *
 *   2. Initialisation is LAZY, and nothing on the plane requires it to have
 *      happened.
 *
 *      `init()` runs migrations and opens a database. Doing that at boot means
 *      a sync server that will not start because a budget is missing — a
 *      second, unrelated product taken down by ours. So the engine initialises
 *      on first use, and `/ping`, `/whoami`, `/capabilities` and `/health` all
 *      answer WITHOUT it, because their job is to tell you it is not ready.
 *
 *   3. Failure is remembered, not retried on every call.
 *
 *      A broken data directory fails the same way every time, and retrying it
 *      per request turns one clear error into a slow one. The failure is
 *      cached with its reason; `resetEngineForTests()` and a restart are the
 *      only ways out.
 */
import fs from 'node:fs';
import path from 'node:path';

import { errorFileFor } from '@actual-app/error-file';

import { MachineError } from './envelope.js';
import { engineSession } from './session.js';

const errors = errorFileFor('sync-server/src/machine/engine.ts');

/**
 * The slice of `@actual-app/api` this plane uses.
 *
 * Declared structurally rather than imported as a type: a static
 * `import type` of a devDependency makes `tsgo -b` require it to be present to
 * typecheck this package, which re-couples the two builds that decision 1
 * exists to separate.
 */
export type EngineLib = {
  send: (name: string, args?: unknown) => Promise<unknown>;
  getDataDir: () => string;
};

type EngineApi = {
  init: (config: {
    dataDir?: string;
    serverURL?: string;
    password?: string;
    sessionToken?: string;
  }) => Promise<EngineLib>;
  shutdown: () => Promise<void>;
  getBudgets: () => Promise<
    Array<{ id?: string; cloudFileId?: string; name: string; state?: 'remote' }>
  >;
  loadBudget: (budgetId: string) => Promise<unknown>;
};

export type EngineStatus =
  /** Never asked for. The normal state of a server nobody has queried yet. */
  | 'idle'
  /** `init()` is in flight. Concurrent callers await the same promise. */
  | 'starting'
  /** Initialised. `budget` says whether one is actually open. */
  | 'ready'
  /** Tried and failed. `error` says why, and it is not retried. */
  | 'failed'
  /** `@actual-app/api` is not installed in this deployment. */
  | 'unavailable';

export type EngineState = {
  status: EngineStatus;
  /** The budget currently open, or null. A ready engine with no budget is normal. */
  budget: { id: string; name: string } | null;
  dataDir: string;
  /**
   * The sync server this engine syncs through — the one it is mounted in.
   * `connected` false means the server is not bootstrapped yet, so the engine
   * is local-only and nothing it does reaches the browser.
   */
  server: { url: string | null; connected: boolean };
  /** Present only when status is 'failed' or 'unavailable'. Never a stack. */
  error?: string;
  /** Always a remediation (§2 R6). */
  hint?: string;
};

let api: EngineApi | null = null;
let lib: EngineLib | null = null;
let status: EngineStatus = 'idle';
let failure: { error: string; hint: string } | null = null;
let openBudget: { id: string; name: string } | null = null;
let starting: Promise<EngineLib> | null = null;
let server: { url: string | null; connected: boolean } = {
  url: null,
  connected: false,
};

/**
 * Where the engine keeps its budget directories.
 *
 * Deliberately NOT the sync server's `userFiles`: those are per-user encrypted
 * blobs uploaded by clients, and pointing a second writer at them is how two
 * processes come to disagree about a file. The engine gets its own directory,
 * and the operator points it at a budget explicitly.
 */
export function engineDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.ACTUAL_MACHINE_DATA_DIR ??
    path.join(env.ACTUAL_DATA_DIR ?? process.cwd(), 'machine-engine')
  );
}

export function engineState(env: NodeJS.ProcessEnv = process.env): EngineState {
  return {
    status,
    budget: openBudget,
    dataDir: engineDataDir(env),
    server,
    ...(failure ?? {}),
  };
}

/**
 * Initialise on first use, and hand back the same instance forever after.
 *
 * Named `requireEngine`, not `useEngine`: this is a monorepo with React in it
 * and the shared lint config applies the rules-of-hooks rule by name, so a
 * `use`-prefixed export here is reported as a misused React hook. `require`
 * also says the right thing — it throws when the engine is unavailable.
 *
 * Throws a MachineError — never a raw one — so a route that needs the engine
 * produces `not_ready` with a hint rather than `internal` with a stack.
 */
export async function requireEngine(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EngineLib> {
  if (lib !== null) {
    return lib;
  }
  if (failure !== null) {
    throw new MachineError('not_ready', failure.error, failure.hint);
  }
  // A second caller arriving mid-init waits for the first one rather than
  // starting a second engine against the same database.
  if (starting !== null) {
    return starting;
  }

  starting = start(env);
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function start(env: NodeJS.ProcessEnv): Promise<EngineLib> {
  status = 'starting';

  const loaded = await loadApi();
  if ('error' in loaded) {
    status = 'unavailable';
    failure = loaded;
    throw new MachineError('not_ready', failure.error, failure.hint);
  }
  api = loaded;

  const dataDir = engineDataDir(env);
  // Join the sync server this process IS, so the browser sees what the
  // engine writes (session.ts). A server nobody has bootstrapped has no
  // owner to be, and the engine starts local-only and says so.
  const session = env.ACTUAL_MACHINE_LOCAL_ONLY === '1' ? null : engineSession(env);
  server = {
    url: session?.serverURL ?? null,
    connected: session !== null,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    lib = await api.init({
      dataDir,
      ...(session === null ? {} : session),
    });
  } catch (err) {
    errors.caught('starting the budget engine', err);
    status = 'failed';
    failure = {
      error: `The budget engine failed to start (${(err as Error).message}).`,
      hint: `check that ${dataDir} is writable, then restart the sync server`,
    };
    lib = null;
    throw new MachineError('not_ready', failure.error, failure.hint);
  }

  status = 'ready';
  failure = null;
  await openConfiguredBudget(env);
  return lib;
}

/**
 * Load `@actual-app/api`, distinguishing "not installed" from "failed to
 * load".
 *
 * The specifier is held in a variable so bundlers treat it as external rather
 * than trying to resolve it at build time — the package is intentionally
 * absent from some deployments and a build-time resolution failure would be a
 * broken server rather than a disabled feature.
 *
 * THE TWO CASES ARE REPORTED DIFFERENTLY, and conflating them cost real time
 * the first day this ran: a blanket `catch { return null }` reports "not
 * installed in this deployment" for EVERY failure, so a package that is
 * installed but whose `dist/` was never built — which is what a stale lage
 * cache produces — sends the operator to install something they already have.
 * §5.4 says a hint must name the actual fix, and a hint that names the wrong
 * one is worse than none.
 */
type ApiLoadFailure = { error: string; hint: string };

async function loadApi(): Promise<EngineApi | ApiLoadFailure> {
  const specifier = '@actual-app/api';
  try {
    return (await import(/* @vite-ignore */ specifier)) as EngineApi;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = (err as Error).message.split('\n')[0];

    // Resolution failed. Either the package is genuinely absent (a production
    // install, which has no devDependencies) or it is present but unbuilt.
    if (
      code === 'ERR_MODULE_NOT_FOUND' ||
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'
    ) {
      // A deployment without the engine is a supported state, not a fault; the
      // hint below carries the remediation.
      errors.expected('loading @actual-app/api', err);
      const unbuilt = message.includes('/dist/');
      return {
        error: unbuilt
          ? '@actual-app/api is installed but has not been built.'
          : '@actual-app/api is not installed in this deployment.',
        hint: unbuilt
          ? 'run `rm -rf .lage && yarn workspace @actual-app/api build` — a stale lage cache reports the build as skipped while dist/ is missing'
          : 'install @actual-app/api alongside the server, or run the machine plane from a repo checkout',
      };
    }

    // Anything else is a real load error — a throw at module scope, a native
    // binding mismatch — and its message is the only useful thing we have.
    errors.caught('loading @actual-app/api', err);
    return {
      error: `@actual-app/api failed to load (${message}).`,
      hint: 'read ~/T/actual_budget/error.err, then rebuild the workspace',
    };
  }
}

/** The budgets this engine can reach: local directories plus the server's files. */
export type KnownBudget = {
  id: string;
  name: string;
  /** `local` is on disk here; `remote` is on the sync server and not yet downloaded; `both` is synced. */
  where: 'local' | 'remote' | 'both';
  cloudFileId?: string;
};

/**
 * `api.getBudgets()` already merges the two sources: a local budget has an
 * `id` (its directory) and, once uploaded, a `cloudFileId`; a file that only
 * exists on the sync server comes back with `state: 'remote'` and no `id`.
 * The pairing is by cloudFileId, and a remote entry whose id a local one
 * carries is the same budget, not a second one.
 */
async function listKnownBudgets(): Promise<KnownBudget[]> {
  if (api === null) {
    return [];
  }
  const files = (await api.getBudgets()) as Array<{
    id?: string;
    cloudFileId?: string;
    name: string;
    state?: 'remote';
  }>;
  const out: KnownBudget[] = [];
  for (const f of files) {
    if (f.id !== undefined) {
      out.push({
        id: f.id,
        name: f.name,
        where: 'local',
        ...(f.cloudFileId ? { cloudFileId: f.cloudFileId } : {}),
      });
    }
  }
  for (const f of files) {
    if (f.id === undefined && f.cloudFileId !== undefined) {
      const synced = out.find(b => b.cloudFileId === f.cloudFileId);
      if (synced) {
        synced.where = 'both';
      } else {
        out.push({ id: f.cloudFileId, name: f.name, where: 'remote', cloudFileId: f.cloudFileId });
      }
    }
  }
  return out;
}

/**
 * Open the budget named by `ACTUAL_MACHINE_BUDGET_ID`, or the only one there
 * is — downloading it from the sync server first when it only exists there.
 *
 * "The only one there is" is a convenience with a hard edge: with two or more
 * budgets and no configured id, NOTHING is opened. Guessing which of an
 * operator's budgets to answer questions about is the single worst mistake
 * available on this plane (mcp.mdx §3), so the engine stays ready-with-no-
 * budget and every route that needs one says which ids exist.
 */
async function openConfiguredBudget(env: NodeJS.ProcessEnv): Promise<void> {
  if (api === null) {
    return;
  }

  const budgets = await listKnownBudgets();
  const wanted = env.ACTUAL_MACHINE_BUDGET_ID;
  const chosen = wanted
    ? budgets.find(b => b.id === wanted || b.cloudFileId === wanted)
    : budgets.length === 1
      ? budgets[0]
      : undefined;

  if (chosen === undefined) {
    openBudget = null;
    return;
  }

  await openKnownBudget(chosen);
}

/**
 * Open one known budget, downloading it first if it is remote-only.
 * Throws a MachineError the route can send as-is.
 */
export async function openKnownBudget(chosen: KnownBudget): Promise<void> {
  if (api === null || lib === null) {
    throw new MachineError('not_ready', 'The engine is not running.');
  }

  let localId = chosen.id;
  if (chosen.where === 'remote') {
    const result = (await lib.send('download-budget', {
      cloudFileId: chosen.cloudFileId ?? chosen.id,
    })) as { id?: string; error?: { reason: string } };
    if (result.error || !result.id) {
      throw new MachineError(
        'upstream_error',
        `The sync server would not hand over budget "${chosen.name}" (${result.error?.reason ?? 'no id'}).`,
        'check the sync server log, then retry',
      );
    }
    localId = result.id;
  }

  try {
    await api.loadBudget(localId);
    openBudget = { id: localId, name: chosen.name };
  } catch (err) {
    errors.caught('opening the budget', err, { budgetId: localId });
    openBudget = null;
    throw new MachineError(
      'upstream_error',
      `Budget "${chosen.name}" could not be opened.`,
      'read ~/T/actual_budget/error.err',
    );
  }
}

/** Record that a route (create, load) opened a budget. */
export function markBudgetOpen(id: string, name: string): void {
  openBudget = { id, name };
}

/** The budgets this install knows — local and on the sync server — for an error that has to name them. */
export async function knownBudgets(): Promise<KnownBudget[]> {
  try {
    return await listKnownBudgets();
  } catch (err) {
    errors.caught('listing the known budgets', err);
    return [];
  }
}

/**
 * The engine AND an open budget. Most routes want this one.
 *
 * Separate from requireEngine() because "the engine is up but no budget is open"
 * is a real, common and differently-remediable state, and collapsing the two
 * produces the wrong hint.
 */
export async function requireBudget(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ lib: EngineLib; budget: { id: string; name: string } }> {
  const engine = await requireEngine(env);
  if (openBudget === null) {
    const ids = await knownBudgets();
    throw new MachineError(
      'not_ready',
      'No budget is open.',
      ids.length === 0
        ? server.connected
          ? 'no budget exists yet — POST /machine/v1/budgets to create one'
          : `no budget files were found in ${engineDataDir(env)}, and the sync server is not bootstrapped so none can be shared — sign in to the web UI once to bootstrap it`
        : `POST /machine/v1/budgets/{id}/load with one of: ${ids.map(b => `${b.id} (${b.name}, ${b.where})`).join(', ')}, or set ACTUAL_MACHINE_BUDGET_ID`,
    );
  }
  return { lib: engine, budget: openBudget };
}

export async function shutdownEngine(): Promise<void> {
  if (api !== null && lib !== null) {
    try {
      await api.shutdown();
    } catch (err) {
      // A shutdown that fails on the way out must not stop the process exiting.
      errors.caught('shutting down the budget engine', err);
    }
  }
  resetEngineForTests();
}

/** Test seam: forget everything, so a test can assert a first-use path. */
export function resetEngineForTests(): void {
  api = null;
  lib = null;
  status = 'idle';
  failure = null;
  openBudget = null;
  starting = null;
  server = { url: null, connected: false };
}

/** Test seam: stand in for `@actual-app/api` without installing it. */
export function setEngineForTests(
  fake: {
    api: EngineApi;
    lib: EngineLib;
    budget?: { id: string; name: string };
  } | null,
): void {
  if (fake === null) {
    resetEngineForTests();
    return;
  }
  api = fake.api;
  lib = fake.lib;
  status = 'ready';
  failure = null;
  openBudget = fake.budget ?? null;
}
