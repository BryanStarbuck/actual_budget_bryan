/**
 * Orientation tools — pm/mcp.mdx §9.5.
 *
 * Three read tools that answer "which install, which budget, is it up".
 */
import { z } from 'zod';

import { errorFileFor } from '../vendor/error-file/index.ts';

import { describe } from './tool.js';
import type { ToolDef } from './tool.js';

const errors = errorFileFor('mcp/src/tools/orientation.ts');

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const noArgs = z.object({}).strip();

export const whoami: ToolDef = {
  name: 'ab_whoami',
  route: { method: 'GET', path: '/whoami' },
  tier: 'read',
  description: describe({
    what: 'Reports which Actual Budget install this server is attached to: the budget file, the server version, the machine-key fingerprint, whether the write tier is on, and whether the target is this machine or a remote one.',
    tier: 'read',
    insteadOf:
      'Call this first when you are unsure whether you are looking at the right budget.',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/whoami');
    const data = (res.data ?? {}) as Record<string, unknown>;
    return {
      data: {
        ...data,
        // What the plane cannot know: which side of the two write switches
        // THIS server holds (§9.7). The plane reports its own tier; without
        // ours beside it, "writes are off" is ambiguous about whose switch.
        apiUrl: ctx.config.apiUrl,
        writeTierOnThisServer: ctx.config.allowWrite,
      },
    };
  },
};

export const health: ToolDef = {
  name: 'ab_health',
  route: { method: 'GET', path: '/health' },
  tier: 'read',
  description: describe({
    what: 'Reports whether the Actual Budget app is running and reachable, and if it is not, gives the exact command the operator must run.',
    tier: 'read',
    insteadOf:
      'This server never starts the app itself — tell the operator the command and wait for them, rather than retrying.',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    // Deliberately does NOT start anything (§9.8). The CLI is invoked by a
    // human who asked for something and will wait 120s for it; an MCP call is
    // invoked by a model that will retry, and a background server starting a
    // detached process tree that outlives the conversation is exactly the kind
    // of surprise an agent should not be able to cause.
    try {
      const res = await ctx.client.request('/health');
      const data = (res.data ?? {}) as Record<string, unknown>;
      return {
        // `reachable` and `healthy` are different questions and the plane
        // distinguishes them: the process answers, but the budget engine may
        // still be idle with nothing loaded. Collapsing the two would have a
        // model report "everything is fine" at a server that cannot answer a
        // single question about money.
        data: { reachable: true, ...data },
      };
    } catch (err) {
      // "The app is down" is this tool's answer, not a fault (R6).
      errors.expected('probing the app health', err);
      return {
        data: {
          up: false,
          reason: (err as Error).message,
          operatorCommand: 'abx up',
          note: 'This server does not start the app. Ask the operator to run the command above.',
        },
      };
    }
  },
};

export const listBudgets: ToolDef = {
  name: 'ab_list_budgets',
  route: { method: 'GET', path: '/budgets' },
  tier: 'read',
  description: describe({
    what: 'Lists the budget files this Actual Budget install knows about, with their ids and names.',
    tier: 'read',
  }),
  inputSchema: NO_ARGS,
  schema: noArgs,
  async run(_args, ctx) {
    const res = await ctx.client.request('/budgets');
    return { data: res.data, untrusted: ['name'] };
  },
};

export const ORIENTATION_TOOLS = [whoami, health, listBudgets];
