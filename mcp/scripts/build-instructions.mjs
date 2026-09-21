#!/usr/bin/env node
/**
 * Generate src/instructions.ts from ai/mcp_prompt.md — pm/mcp.mdx §3.4.
 *
 * The prompt file is the single source. It is prose a human maintains, it
 * lives at the repo top level beside pm/ rather than inside mcp/src/, and
 * CLAUDE.md names it as the prompt file this server uses.
 *
 * Three rules this script exists to enforce:
 *
 *   1. An UNKNOWN {TOKEN} is a build failure naming the token. Shipping a
 *      literal brace to the model is worse than not building: the model reads
 *      "{TOOL_PREFIX}list_accounts" and there is no such tool.
 *
 *   2. A MISSING OR EMPTY prompt file is a build failure. There is no fallback
 *      string. A server that silently ships an empty instructions block has
 *      lost the whole §3.4 routing defence with nothing to show for it — the
 *      tools still appear, they just answer about the wrong ledger sometimes.
 *
 *   3. The first sentence must be the routing test. It is the first thing the
 *      model reads, before any tool description, and §3.4 layer 5 is the only
 *      reason a model that has not yet read a description routes correctly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpRoot = path.resolve(here, '..');
const repoRoot = path.resolve(mcpRoot, '..');

const PROMPT_FILE = path.join(repoRoot, 'ai', 'mcp_prompt.md');
const OUT_FILE = path.join(mcpRoot, 'src', 'instructions.ts');

/**
 * The substitution map. Every {TOKEN} in the prompt must appear here, and
 * every entry here should appear in the prompt — an unused entry is a token
 * somebody removed from the prose and forgot to remove here.
 */
const TOKENS = {
  SERVER_KEY: 'actual_budget',
  TOOL_PREFIX: 'ab_',
  TOTAL_TOOLS: '38',
  READ_TOOLS: '31',
  WRITE_TOOLS: '7',
  API_URL: 'http://127.0.0.1:5006',
  CREDENTIALS_FILE: '~/.credentials/actual_budget.json',
  CLI_BINARY: 'abx',
};

/** §3.4 layer 5, verbatim. A test asserts the shipped text starts with this. */
const REQUIRED_OPENING =
  "Is this about the operator's own personal or household budget";

function fail(message) {
  process.stderr.write(`build-instructions: ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(PROMPT_FILE)) {
  fail(
    `${PROMPT_FILE} does not exist.\n` +
      '  This file IS the instructions block the model reads. There is no default.\n' +
      '  See pm/mcp.mdx §3.4.',
  );
}

const source = fs.readFileSync(PROMPT_FILE, 'utf8');

if (source.trim().length === 0) {
  fail(
    `${PROMPT_FILE} is empty.\n` +
      '  Refusing to ship an empty instructions block — see pm/mcp.mdx §3.4.',
  );
}

// Substitute, collecting unknown tokens rather than stopping at the first, so
// one build run reports every one of them.
const unknown = new Set();
const rendered = source.replace(/\{([A-Z0-9_]+)\}/g, (match, token) => {
  if (Object.hasOwn(TOKENS, token)) {
    return TOKENS[token];
  }
  unknown.add(token);
  return match;
});

if (unknown.size > 0) {
  fail(
    `unknown token(s) in ${path.relative(repoRoot, PROMPT_FILE)}: ` +
      `${[...unknown].map(t => `{${t}}`).join(', ')}\n` +
      '  Add them to TOKENS in this script, or fix the spelling in the prompt.',
  );
}

const unused = Object.keys(TOKENS).filter(
  token => !source.includes(`{${token}}`),
);
if (unused.length > 0) {
  process.stderr.write(
    `build-instructions: note — TOKENS entries unused by the prompt: ${unused.join(', ')}\n`,
  );
}

if (!rendered.trimStart().startsWith(REQUIRED_OPENING)) {
  fail(
    'the prompt must OPEN with the routing test (pm/mcp.mdx §3.4 layer 5).\n' +
      `  Expected it to start with: "${REQUIRED_OPENING}…"\n` +
      '  The model reads this before any tool description; it is the only thing\n' +
      '  standing between a finance question and the quickbooks server.',
  );
}

const banner = `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Built from ai/mcp_prompt.md by mcp/scripts/build-instructions.mjs.
 * Edit the prompt, not this file; a test asserts the two agree, so a stale
 * artifact cannot ship (pm/mcp.mdx §3.4).
 */`;

const body = `${banner}
export const INSTRUCTIONS = ${JSON.stringify(rendered)};
`;

// Only rewrite when the content actually changed, so a no-op build does not
// churn the file's mtime and re-trigger every downstream watcher.
const existing = fs.existsSync(OUT_FILE)
  ? fs.readFileSync(OUT_FILE, 'utf8')
  : null;

if (existing !== body) {
  fs.writeFileSync(OUT_FILE, body, 'utf8');
  process.stderr.write(
    `build-instructions: wrote src/instructions.ts (${rendered.length} chars)\n`,
  );
}
