import { Server } from '@modelcontextprotocol/sdk/server/index.js';
/**
 * The JSON-RPC surface — pm/mcp.mdx §8, §9.3, §12.
 *
 * We use the SDK's low-level `Server` with explicit request handlers rather
 * than `McpServer` + `registerTool`, because registerTool accepts only a Zod
 * schema or a raw shape and throws on literal JSON Schema. We hand-author the
 * JSON Schema so the field descriptions the model reads are EXACTLY what we
 * wrote — those descriptions are the product (§8.2). Zod is still used, for
 * runtime parsing inside each tool (gate 5).
 */
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { auditLine } from './audit.js';
import type { MachinePlaneClient } from './client.js';
import type { Config } from './config.js';
import { ToolError } from './envelope.js';
import type { Envelope } from './envelope.js';
import { checkInput, checkMode, checkNotForeign } from './gates.js';
import { INSTRUCTIONS } from './instructions.js';
import type { Logger } from './logger.js';
import { findTool, TOOLS } from './tools/registry.js';
import type { ToolDef } from './tools/tool.js';

export const SERVER_NAME = 'actual_budget';
export const SERVER_VERSION = '0.1.0';

export type HostOptions = {
  config: Config;
  client: MachinePlaneClient;
  logger: Logger;
  keyFingerprint: string;
};

/**
 * When the write tier is off, a write tool is still LISTED — with its
 * description saying so and naming both switches. A tool that vanishes
 * teaches the model nothing, and a model that cannot see the tool goes
 * looking for another way to do the same thing (§7.1 gate 4).
 */
function describeForListing(tool: ToolDef, config: Config): string {
  if (tool.tier !== 'write') {
    return tool.description;
  }
  if (config.target === 'remote') {
    return `${tool.description} CURRENTLY DISABLED: this server is pointed at a remote install, which is read-only.`;
  }
  if (!config.allowWrite) {
    return `${tool.description} CURRENTLY DISABLED: the write tier is off. To enable it the operator must set ACTUAL_MACHINE_ALLOW_WRITE=1 on the sync server and ABMCP_ALLOW_WRITE=1 on this server, then restart both.`;
  }
  return tool.description;
}

export class McpServerHost {
  readonly #opts: HostOptions;
  readonly server: Server;

  constructor(opts: HostOptions) {
    this.#opts = opts;

    this.server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        // Capabilities are `{ tools: {} }` and nothing else. Every
        // unnecessary primitive is another surface a model can wander into,
        // and prompts/* and resources/* answer -32601 by simply not being
        // declared (§8).
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () =>
      this.handleListTools(),
    );
    this.server.setRequestHandler(CallToolRequestSchema, async request =>
      this.handleCallTool(request.params.name, request.params.arguments ?? {}),
    );
  }

  handleListTools(): {
    tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }>;
  } {
    return {
      tools: TOOLS.map(tool => ({
        name: tool.name,
        description: describeForListing(tool, this.#opts.config),
        inputSchema: tool.inputSchema,
      })),
    };
  }

  async handleCallTool(
    name: string,
    args: unknown,
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { config, client, logger, keyFingerprint } = this.#opts;
    const startedAt = Date.now();
    const tool = findTool(name);

    if (tool === undefined) {
      // Not a protocol error: an unknown tool name is a tool-level failure so
      // that losing one call does not kill the model's loop (§12.2).
      return this.#respond(
        {
          ok: false,
          tool: name,
          error: {
            code: 'not_found',
            message: `No tool named "${name}" on this server.`,
            hint: 'every tool here begins with `ab_`; list the tools to see them',
          },
        },
        true,
      );
    }

    let gate: string | undefined;
    try {
      gate = 'routing';
      checkNotForeign(args);

      gate = 'mode';
      checkMode(tool, config);

      gate = 'input';
      const parsed = checkInput(tool, args);

      gate = undefined;
      const result = await tool.run(parsed, { client, config });

      const rows = Array.isArray(result.data) ? result.data.length : undefined;
      logger.audit(
        auditLine({
          tool: name,
          tier: tool.tier,
          target: config.target,
          args,
          ok: true,
          tookMs: Date.now() - startedAt,
          keyFingerprint,
          ...(rows === undefined ? {} : { rows }),
        }),
        false,
      );

      const envelope: Envelope = {
        ok: true,
        tool: name,
        data: result.data,
        meta: {
          target: config.target,
          asOf: new Date().toISOString(),
          tookMs: Date.now() - startedAt,
          truncated: result.truncated ?? false,
          ...(result.limitApplied === undefined
            ? {}
            : { limitApplied: result.limitApplied }),
          ...(result.untrusted === undefined
            ? {}
            : { untrusted: result.untrusted }),
          ...(result.budgetId === undefined
            ? {}
            : { budgetId: result.budgetId }),
          ...(result.budgetName === undefined
            ? {}
            : { budgetName: result.budgetName }),
        },
      };

      return this.#respond(envelope, false);
    } catch (err) {
      const toolError =
        err instanceof ToolError
          ? err
          : new ToolError(
              'internal',
              'The tool failed unexpectedly.',
              'check ~/T/_actual_budget/mcp.err',
            );

      // The stack goes to the file; the model gets a code and a hint. A stack
      // in a model's context window is noise it cannot act on, and it can
      // carry paths we would rather not disclose (§7.4).
      if (!(err instanceof ToolError)) {
        logger.error(`${name}: ${(err as Error).stack ?? String(err)}`);
      }

      logger.audit(
        auditLine({
          tool: name,
          tier: tool.tier,
          target: config.target,
          args,
          ok: false,
          tookMs: Date.now() - startedAt,
          keyFingerprint,
          ...(gate === undefined ? {} : { gate }),
          errorCode: toolError.code,
        }),
        true,
      );

      return this.#respond(
        {
          ok: false,
          tool: name,
          error: {
            code: toolError.code,
            message: toolError.message,
            ...(toolError.hint === undefined ? {} : { hint: toolError.hint }),
          },
        },
        true,
      );
    }
  }

  /** One text content block holding pretty-printed JSON (§12.1). */
  #respond(
    envelope: Envelope,
    isError: boolean,
  ): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      ...(isError ? { isError: true } : {}),
    };
  }
}
