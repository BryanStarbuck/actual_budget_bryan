/**
 * The verb shape — pm/cli.mdx §6, §7.3.
 *
 * A verb declares its own flags, with arity, right here. That declaration is
 * the ONLY place a flag exists: the parser derives `takesValue` from it, and
 * `abx help <verb>` prints from it. There is no second list, for the same
 * reason tools/list and dispatch read one array in the MCP — two lists that
 * must agree are two lists that will not.
 */
import type { FlagSpecs, ParsedArgs } from './args.js';
import type { Target } from './client.js';
import type { Logger } from './logger.js';
import type { Format } from './render.js';

export type Context = {
  args: ParsedArgs;
  target: Target;
  format: Format;
  quiet: boolean;
  verbose: boolean;
  /** --no-bringup inverted: may this verb start the app? */
  mayBringUp: boolean;
  repoRoot: string;
  logger: Logger;
  env: NodeJS.ProcessEnv;
  /** Resolve the machine key, minting one if absent. Throws R6's message if it cannot. */
  requireKey(): string;
};

export type Verb = {
  /** Space-separated, as it is typed: "accounts balance". */
  name: string;
  summary: string;
  /** Positional arguments, for help text: ['<id>']. */
  positionals?: string[];
  flags?: FlagSpecs;
  /** Verbs that never touch the machine plane skip the preflight entirely. */
  local?: boolean;
  run(ctx: Context): Promise<number>;
};

export function flagsFor(verb: Verb, universal: FlagSpecs): FlagSpecs {
  return { ...universal, ...(verb.flags ?? {}) };
}
