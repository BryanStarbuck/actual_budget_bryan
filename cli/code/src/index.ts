import { main } from './main.js';

const code = await main(process.argv.slice(2));

// Flush before exiting: process.exit truncates a pending stdout write, which
// on a pipe is how `abx accounts list | jq` intermittently loses its last line.
process.exitCode = code;
