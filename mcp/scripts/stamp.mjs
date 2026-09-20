#!/usr/bin/env node
/**
 * Stamp dist/index.js executable — pm/mcp.mdx §5.3.
 *
 * Claude Code spawns the server with `command` pointing straight at this file,
 * so it needs a shebang and the execute bit. Without them the failure is the
 * server SILENTLY never starting: the tools are simply absent from the
 * catalogue and nothing says why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'dist',
  'index.js',
);

const source = fs.readFileSync(entry, 'utf8');
if (!source.startsWith('#!')) {
  fs.writeFileSync(entry, `#!/usr/bin/env node\n${source}`, 'utf8');
}
fs.chmodSync(entry, 0o755);
process.stderr.write('stamp: dist/index.js is executable\n');
