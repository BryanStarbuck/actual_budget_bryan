/**
 * P1 — engine lifecycle, and the guard that refuses to guess a budget.
 *
 * pm/apis.mdx §8.0, §15. The multi-budget case is the one that matters: an
 * engine that picks a budget for you is an engine that answers questions
 * about the wrong ledger, which mcp.mdx §3 spends a whole section preventing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  engineDataDir,
  engineState,
  requireBudget,
  resetEngineForTests,
  setEngineForTests,
} from './engine.js';

let tmp: string;

const lib = { send: async () => null, getDataDir: () => '/tmp' };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-test-'));
  resetEngineForTests();
});

afterEach(() => {
  resetEngineForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('engineDataDir', () => {
  it('prefers the explicit override', () => {
    expect(engineDataDir({ ACTUAL_MACHINE_DATA_DIR: '/x' })).toBe('/x');
  });

  it('otherwise nests under the server data dir, never ON it', () => {
    // Never the server's own dataDir: userFiles and server-files live there,
    // and a second writer pointed at them is how two processes come to
    // disagree about a file.
    expect(engineDataDir({ ACTUAL_DATA_DIR: '/data' })).toBe(
      '/data/machine-engine',
    );
  });
});

describe('the engine starts idle and says so', () => {
  it('reports idle rather than throwing before first use', () => {
    expect(engineState({}).status).toBe('idle');
    expect(engineState({}).budget).toBeNull();
  });
});

describe('requireBudget refuses to guess (§8.0)', () => {
  it('names the ids when the engine is ready but no budget is open', async () => {
    setEngineForTests({
      api: {
        init: async () => lib,
        shutdown: async () => undefined,
        getBudgets: async () => [
          { id: 'household', name: 'Household' },
          { id: 'acme', name: 'Acme LLC' },
        ],
        loadBudget: async () => undefined,
      },
      lib,
      // Deliberately none open: two exist and none was configured.
      budget: undefined,
    });

    await expect(requireBudget({})).rejects.toMatchObject({
      code: 'not_ready',
      message: 'No budget is open.',
    });

    try {
      await requireBudget({});
    } catch (err) {
      // The refusal has to be actionable: it names both candidates so the
      // operator can set the variable without going to look them up.
      expect((err as { hint: string }).hint).toContain('household');
      expect((err as { hint: string }).hint).toContain('acme');
      expect((err as { hint: string }).hint).toContain(
        'ACTUAL_MACHINE_BUDGET_ID',
      );
    }
  });

  it('hands back the open budget when there is one', async () => {
    setEngineForTests({
      api: {
        init: async () => lib,
        shutdown: async () => undefined,
        getBudgets: async () => [{ id: 'only', name: 'Only' }],
        loadBudget: async () => undefined,
      },
      lib,
      budget: { id: 'only', name: 'Only' },
    });

    const { budget } = await requireBudget({});
    expect(budget).toEqual({ id: 'only', name: 'Only' });
  });
});
