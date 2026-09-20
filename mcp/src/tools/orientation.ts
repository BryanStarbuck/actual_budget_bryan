/**
 * Orientation tools — pm/mcp.mdx §9.5.
 *
 * Three read tools that answer "which install, which budget, is it up".
 */
import { z } from 'zod';

import { describe } from './tool.js';
import type { ToolDef } from './tool.js';

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
const noArgs = z.object({}).strip();

export const whoami: ToolDef = {
  name: 'ab_whoami',
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
    const res = await ctx.client.request('/ping');
    const data = res.data as Record<string, unknown>;
    return {
      data: {
        ...data,
        target: ctx.config.target,
        apiUrl: ctx.config.apiUrl,
        writeTierOnThisServer: ctx.config.allowWrite,
      },
    };
  },
};

export const health: ToolDef = {
  name: 'ab_health',
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
      const res = await ctx.client.request('/ping');
      return {
        data: { up: true, detail: res.data },
      };
    } catch (err) {
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
