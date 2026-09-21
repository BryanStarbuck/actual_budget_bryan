/**
 * Dispatch — pm/cli.mdx §6, §8, §13, §14.
 *
 * Resolve a verb, parse its declared flags, run it, and turn whatever comes
 * back into an exit code. Everything printed here that is not the answer goes
 * to stderr (§13.1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getBoolean, getString, parseArgs, UNIVERSAL_FLAGS } from './args.js';
import { ensureServerUp } from './bringup.js';
import { resolveTarget } from './client.js';
import * as categories from './commands/categories.js';
import * as orientation from './commands/orientation.js';
import * as reads from './commands/reads.js';
import {
  CredentialsError,
  credentialsPath,
  resolveMachineKey,
} from './credentials.js';
import { CliError, Exit } from './exit.js';
import type { ExitCode } from './exit.js';
import { Logger } from './logger.js';
import { withSpinner } from './progress.js';
import { parseFormat } from './render.js';
import { errorFileFor } from './vendor/error-file/index.ts';
import { flagsFor } from './verb.js';
import type { Context, Verb } from './verb.js';

const errors = errorFileFor('cli/code/src/main.ts');

/**
 * The verb table. One array, read by dispatch AND by help, so a verb cannot
 * exist in one and not the other.
 */
const VERBS: Verb[] = [
  orientation.doctor,
  orientation.up,
  orientation.stop,
  orientation.status,
  orientation.logs,
  orientation.key,
  orientation.ping,
  orientation.whoami,
  orientation.capabilities,
  orientation.health,
  reads.budgets,
  reads.accountsList,
  reads.accountsBalance,
  reads.transactionsList,
  reads.statementsManifest,
  categories.categoriesTree,
];

function repoRoot(): string {
  // dist/main.js -> dist -> code -> cli -> repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

/**
 * Longest-match verb resolution, so "statements scan" beats "statements".
 * Returns the verb and the argv left over after its name.
 */
function resolveVerb(argv: string[]): { verb: Verb; rest: string[] } | null {
  for (const words of [2, 1]) {
    const candidate = argv.slice(0, words).join(' ');
    const verb = VERBS.find(v => v.name === candidate);
    if (verb !== undefined) {
      return { verb, rest: argv.slice(words) };
    }
  }
  return null;
}

function usage(): string {
  const lines = [
    'abx — the operator CLI for this install of Actual Budget',
    '',
    'ORIENTATION',
    '  abx                                  status, and what needs doing',
  ];
  for (const verb of VERBS) {
    const positionals = (verb.positionals ?? []).join(' ');
    lines.push(
      `  abx ${`${verb.name} ${positionals}`.trim().padEnd(34)} ${verb.summary}`,
    );
  }
  lines.push('', 'Every verb takes the universal flags:');
  for (const [name, spec] of Object.entries(UNIVERSAL_FLAGS)) {
    if (name === 'h') {
      continue;
    }
    lines.push(`  --${name.padEnd(14)} ${spec.help}`);
  }
  return lines.join('\n');
}

function verbHelp(verb: Verb): string {
  const lines = [
    `abx ${verb.name} ${(verb.positionals ?? []).join(' ')}`.trim(),
    `  ${verb.summary}`,
  ];
  const own = Object.entries(verb.flags ?? {});
  if (own.length > 0) {
    lines.push('', 'Flags:');
    for (const [name, spec] of own) {
      const arity = spec.arity === 'boolean' ? '' : ` <${spec.arity}>`;
      lines.push(`  --${name}${arity}`.padEnd(28) + spec.help);
    }
  }
  lines.push(
    '',
    'Universal flags: --format --write --yes --api --quiet --verbose --help',
  );
  return lines.join('\n');
}

/**
 * Print a failure to stderr — never stdout, which belongs to the answer.
 *
 * The hint is the point. Every failure this CLI produces is one somebody has
 * to get out of, and the CLI is the program that knows which file, port or
 * flag was involved.
 */
function reportError(err: CliError, jsonErrors: boolean): void {
  if (jsonErrors) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, exit: err.code, message: err.message, hint: err.hint })}\n`,
    );
    return;
  }

  const lines = [`abx: ${err.message}`];
  if (err.hint !== undefined) {
    lines.push(`  fix: ${err.hint}`);
  }
  if (err.detail !== undefined) {
    lines.push(...err.detail.split('\n').map(line => `  | ${line}`));
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

/**
 * Everything thrown becomes a CliError with the right exit code.
 *
 * The CredentialsError case matters: a refusal to read a 0644 credentials
 * file is a LOCAL refusal before any call, which is exit 2 (§14), and it
 * carries the exact `chmod` that fixes it. Falling through to the generic
 * handler would report it as exit 1 with no remedy — the difference between a
 * ten-second fix and an afternoon.
 */
function asCliError(err: unknown): CliError {
  if (err instanceof CliError) {
    return err;
  }
  if (err instanceof CredentialsError) {
    return new CliError(Exit.usage, err.message, { hint: err.fix });
  }
  return new CliError(Exit.failed, (err as Error).message);
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ExitCode> {
  const logger = new Logger(env);
  let jsonErrors = false;
  let verbName = '';

  try {
    // Help moves off the bare invocation (§8): bare `abx` is the orientation
    // report, and help is an explicit verb.
    if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
      const target = argv[1] === undefined ? null : resolveVerb(argv.slice(1));
      process.stdout.write(
        `${target === null ? usage() : verbHelp(target.verb)}\n`,
      );
      return Exit.ok;
    }

    const resolved =
      argv.length === 0
        ? { verb: orientation.orient, rest: [] }
        : resolveVerb(argv);

    if (resolved === null) {
      process.stderr.write(`abx: unknown verb "${argv.join(' ')}"\n\n`);
      process.stderr.write(`${usage()}\n`);
      return Exit.usage;
    }

    const { verb, rest } = resolved;
    verbName = verb.name;
    const args = parseArgs(rest, flagsFor(verb, UNIVERSAL_FLAGS));
    jsonErrors = getBoolean(args, 'json-errors');

    if (getBoolean(args, 'help') || getBoolean(args, 'h')) {
      process.stdout.write(`${verbHelp(verb)}\n`);
      return Exit.ok;
    }

    const target = resolveTarget(getString(args, 'api'), env);
    const verbose = getBoolean(args, 'verbose');

    const ctx: Context = {
      args,
      target,
      format: parseFormat(getString(args, 'format')),
      quiet: getBoolean(args, 'quiet'),
      verbose,
      mayBringUp: !getBoolean(args, 'no-bringup'),
      repoRoot: repoRoot(),
      logger,
      env,
      requireKey(): string {
        const key = resolveMachineKey({ env, mint: true, mintedBy: 'abx' });
        if (key === null) {
          // R6 — a missing key is a LOUD local failure naming the file and the
          // remedy, never a silent 401. The shipped-elsewhere behaviour this
          // exists to prevent is `if (key) headers[...] = key`, where the whole
          // failure surfaces as a server 401 with a deliberately
          // uninformative body.
          throw new CliError(
            Exit.usage,
            `No machine key for ${target.baseUrl}.`,
            {
              hint: 'abx key init   (or start the app, which mints one: abx up)',
              detail: [
                'Looked in: ABX_MACHINE_KEY, ABX_MACHINE_KEY_FILE,',
                `           ${credentialsPath(env)}  (actual_budget.machine.api_key)`,
              ].join('\n'),
            },
          );
        }
        return key.key;
      },
    };

    if (verbose) {
      process.stderr.write(`target: ${target.baseUrl} (${target.kind})\n`);
    }

    // The liveness preflight (§3.1). Every invocation that needs the machine
    // plane begins here: `abx` never says "start the server first". Verbs
    // marked `local` skip it — `doctor` and `status` have to work precisely
    // when the app is down, and bare `abx` is a question, not an instruction.
    if (verb.local !== true) {
      await withSpinner({ quiet: ctx.quiet }, spinner =>
        ensureServerUp({
          baseUrl: target.baseUrl,
          repoRoot: ctx.repoRoot,
          env,
          spinner,
          allowed: ctx.mayBringUp,
        }),
      );
    }

    const startedAt = Date.now();
    const code = await verb.run(ctx);
    logger.info(
      'INFO',
      `verb=${verb.name || 'orient'} exit=${code} ms=${Date.now() - startedAt}`,
    );
    return code as ExitCode;
  } catch (err) {
    const cliError = asCliError(err);

    // The stack goes to the FILE. One sentence plus the remedy goes to the
    // operator — a stack on stderr buries the fix under twelve frames of our
    // own call graph, which is not information the operator can act on (§15).
    logger.error('ERROR', `${cliError.message}\n${(err as Error).stack ?? ''}`);
    // pm/error_err.mdx §7 N18: the same fault also lands in error.err, next to cli.err. A usage
    // refusal (bad flag, missing key, unreadable credentials file) is an answer, not a fault (R7).
    if (cliError.code === Exit.usage) {
      errors.expected('running an abx verb', err);
    } else {
      errors.caught('running an abx verb', err, {
        verb: verbName,
        exit: cliError.code,
      });
    }
    reportError(cliError, jsonErrors);
    return cliError.code;
  }
}
