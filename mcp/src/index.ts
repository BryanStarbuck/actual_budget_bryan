/**
 * Entry point — pm/mcp.mdx §6.3, §14, §15.
 *
 * Startup is lazy about nothing that can fail loudly: key, config and target
 * are resolved BEFORE the transport is attached, so a misconfiguration is a
 * clean refusal on stderr rather than a server that connects and then 500s on
 * every call.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { CapabilityCache } from './capabilities.js';
import { MachinePlaneClient } from './client.js';
import { ConfigError, loadConfig } from './config.js';
import type { Config } from './config.js';
import {
  CredentialsError,
  fingerprint,
  resolveMachineKey,
} from './credentials.js';
import { Logger } from './logger.js';
import { McpServerHost, SERVER_NAME, SERVER_VERSION } from './server.js';

function refuse(message: string, fix: string): never {
  // stderr, always. stdout is the wire (§8.1), and a refusal printed there
  // would be the first thing to corrupt the stream we are refusing to start.
  process.stderr.write(`${SERVER_NAME}: ${message}\n  fix: ${fix}\n`);
  process.exit(2);
}

export class Main {
  static async run(argv: string[]): Promise<void> {
    if (argv[0] !== 'serve') {
      process.stderr.write(
        `usage: ${SERVER_NAME} serve\n\n` +
          '  Registered with:\n' +
          '    claude mcp add actual_budget -- "$HOME/BGit/Bryan_git/actual_budget_bryan/mcp/dist/index.js" serve\n' +
          '  The bare -- is load-bearing: without it `serve` is eaten by the\n' +
          '  wrong parser and the server starts with no subcommand.\n',
      );
      process.exit(2);
    }

    let config: Config;
    try {
      config = loadConfig();
    } catch (err) {
      if (err instanceof ConfigError) {
        refuse(err.message, err.fix);
      }
      throw err;
    }

    const logger = new Logger({ dir: config.logDir, level: config.logLevel });

    // Fail closed, harder than the CLI (§6.3). The CLI may proceed without a
    // key and let the server answer 401; this server refuses to start,
    // because a model retrying a 401 forty times is a worse outcome than a
    // server that is absent from the catalogue with a one-line reason.
    let key: string;
    try {
      const resolved = resolveMachineKey({
        env: { ...process.env, ABX_CREDENTIALS_FILE: config.credentialsFile },
        mint: true,
        mintedBy: 'mcp',
      });
      if (resolved === null) {
        refuse(
          'no machine key could be resolved.',
          'run `abx key init`, or start the app once so it mints one',
        );
      }
      key = resolved.key;
    } catch (err) {
      if (err instanceof CredentialsError) {
        refuse(err.message, err.fix);
      }
      throw err;
    }

    const keyFingerprint = fingerprint(key);
    const client = new MachinePlaneClient(config, key);
    const capabilities = new CapabilityCache(client);
    const host = new McpServerHost({
      config,
      client,
      logger,
      keyFingerprint,
      capabilities,
    });

    // One line, stderr, naming the target — so a transcript shows which
    // install answered (§7.3).
    logger.banner(
      `${SERVER_NAME} ${SERVER_VERSION} -> ${config.apiUrl} (${config.target}) ` +
        `key ${keyFingerprint} writes ${config.allowWrite ? 'ENABLED' : 'off'}`,
    );
    logger.info(
      `start target=${config.target} url=${config.apiUrl} writes=${String(config.allowWrite)} key=${keyFingerprint}`,
    );

    const transport = new StdioServerTransport();
    await host.server.connect(transport);

    const shutdown = (signal: string) => {
      logger.info(`shutdown signal=${signal}`);
      void host.server.close().finally(() => {
        process.exit(0);
      });
    };
    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });

    // An unhandled rejection must not take the server down mid-conversation
    // and must never reach stdout.
    process.on('unhandledRejection', reason => {
      logger.error(`unhandledRejection: ${String(reason)}`);
    });
  }
}

await Main.run(process.argv.slice(2));
