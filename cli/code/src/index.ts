import { main } from './main.js';
import { installNodeErrorFile } from './vendor/error-file/node.ts';

// pm/error_err.mdx §7 N18: the process-level net, before anything else runs.
installNodeErrorFile({ app: 'abx', where: 'cli/code/src/index.ts' });

const code = await main(process.argv.slice(2));

// Flush before exiting: process.exit truncates a pending stdout write, which
// on a pipe is how `abx accounts list | jq` intermittently loses its last line.
process.exitCode = code;
