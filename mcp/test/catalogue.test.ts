/**
 * Catalogue tests — pm/mcp.mdx §17.
 *
 * These assert the properties that make the catalogue navigable by a model:
 * the naming scheme, the four mandatory description clauses, the money rule
 * in every schema, and the one-array rule.
 */
import { describe, expect, it } from 'vitest';

import { ERROR_CODES, MCP_ONLY_CODES } from '../src/envelope.js';
import { findTool, TOOL_COUNTS, TOOLS } from '../src/tools/registry.js';
import { READS_ONLY, WHICH_SERVER, WRITES } from '../src/tools/tool.js';

/** The nine the machine plane can return — cli.mdx §5.3. */
const PLANE_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_input',
  'conflict',
  'write_disabled',
  'not_ready',
  'upstream_error',
  'internal',
];

describe('naming (§9.1, §3.2)', () => {
  it('every tool starts with ab_ and is lowercase snake_case', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).toMatch(/^ab_[a-z][a-z0-9_]*$/);
    }
  });

  it('every verb comes from the closed set', () => {
    // No generate_ family: this server spends no credits and calls no model.
    // No search_ family: list_ with a filter is the same thing, and search_
    // is the verb BOTH neighbours use (§3.3).
    // The table in §9.1, plus the three bare names it names explicitly.
    const verbs = new Set([
      // read
      'list',
      'get',
      'scan',
      'plan',
      'describe',
      'extract',
      // write
      'add',
      'update',
      'set',
      'delete',
      'apply',
      'sync',
      // bare, because the noun would be this server
      'whoami',
      'health',
      'query',
    ]);
    for (const tool of TOOLS) {
      const verb = tool.name.slice('ab_'.length).split('_')[0];
      expect(verbs.has(verb ?? ''), `${tool.name} uses verb "${verb}"`).toBe(
        true,
      );
    }
  });

  it("no tool name collides with a neighbour's bare name", () => {
    // §3.3 — the names both neighbours already occupy. The ab_ prefix is what
    // survives a model losing the server segment entirely.
    const taken = [
      'get_account',
      'search_accounts',
      'create_account',
      'search_budgets',
      'get_credits',
      'list_projects',
      'create_invoice',
    ];
    for (const tool of TOOLS) {
      expect(taken).not.toContain(tool.name);
    }
  });
});

describe('the four mandatory description clauses (§9.2)', () => {
  it('every tool says which server it is', () => {
    for (const tool of TOOLS) {
      expect(tool.description, tool.name).toContain(WHICH_SERVER);
    }
  });

  it('every tool states its cost, and write tools do not soften it', () => {
    for (const tool of TOOLS) {
      if (tool.tier === 'read') {
        expect(tool.description, tool.name).toContain(READS_ONLY);
      } else {
        expect(tool.description, tool.name).toContain(WRITES);
        // The real affordance: a bad write is on the operator's phone before
        // anyone reviews it.
        expect(tool.description, tool.name).toContain('synced');
      }
    }
  });

  it('every description opens with a sentence about what it does', () => {
    for (const tool of TOOLS) {
      const first = tool.description.split('. ')[0] ?? '';
      expect(first.length, tool.name).toBeGreaterThan(20);
      expect(first, tool.name).not.toContain('Reads only');
    }
  });
});

describe('one array, no second list (§9.3)', () => {
  it('every listed tool is dispatchable, and vice versa', () => {
    for (const tool of TOOLS) {
      expect(findTool(tool.name), tool.name).toBe(tool);
    }
    expect(findTool('ab_not_a_tool')).toBeUndefined();
  });

  it('no tool is defined twice', () => {
    const names = TOOLS.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('the counts are what the spec and the instructions block claim', () => {
    // The prompt file states these numbers to the model. If the catalogue
    // changes and the prompt does not, the model is told something false.
    expect(TOOL_COUNTS).toEqual({ total: 38, read: 31, write: 7 });
  });
});

describe('the money rule in every schema (§10.1)', () => {
  function amountFields(
    schema: unknown,
    path: string[] = [],
  ): Array<{ path: string; field: Record<string, unknown> }> {
    if (schema === null || typeof schema !== 'object') {
      return [];
    }
    const node = schema as Record<string, unknown>;
    const found: Array<{ path: string; field: Record<string, unknown> }> = [];

    const properties = node.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    for (const [name, child] of Object.entries(properties ?? {})) {
      const here = [...path, name];
      if (/amount/i.test(name)) {
        found.push({ path: here.join('.'), field: child });
      }
      found.push(...amountFields(child, here));
    }
    if (node.items !== undefined) {
      found.push(...amountFields(node.items, [...path, '[]']));
    }
    return found;
  }

  it('every amount field is an integer and says CENTS with an example', () => {
    let checked = 0;
    for (const tool of TOOLS) {
      for (const { path, field } of amountFields(tool.inputSchema)) {
        checked++;
        const where = `${tool.name}.${path}`;
        expect(field.type, where).toBe('integer');
        expect(String(field.description), where).toContain('CENTS');
        // An example, because "integer cents" alone still leaves a model
        // guessing at the scale.
        expect(String(field.description), where).toMatch(/\d{3,}/);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('no schema anywhere declares a number type for an amount', () => {
    for (const tool of TOOLS) {
      for (const { path, field } of amountFields(tool.inputSchema)) {
        expect(field.type, `${tool.name}.${path}`).not.toBe('number');
      }
    }
  });
});

describe('the error vocabulary (§12.3)', () => {
  it('is exactly twelve codes', () => {
    expect(ERROR_CODES).toHaveLength(12);
  });

  it("is a strict superset of the machine plane's nine", () => {
    // So a server error can pass through unchanged (cli.mdx §5.3).
    for (const code of PLANE_CODES) {
      expect(ERROR_CODES).toContain(code);
    }
  });

  it('the three extra codes are ours alone and never come off the wire', () => {
    expect(MCP_ONLY_CODES).toEqual([
      'confirm_required',
      'too_many_changes',
      'wrong_server',
    ]);
    for (const code of MCP_ONLY_CODES) {
      expect(PLANE_CODES).not.toContain(code);
    }
  });
});

describe('what the catalogue deliberately does NOT contain (§9.5, §11.3)', () => {
  it('has no tool that deletes anything', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).not.toMatch(/delete|remove|destroy|purge/);
    }
  });

  it('has no tool that judges a duplicate', () => {
    for (const tool of TOOLS) {
      expect(tool.name, tool.name).not.toMatch(/dedup|merge|mark_duplicate/);
    }
  });

  it('accepts no argument that would re-import a deleted transaction', () => {
    // §11.3 — resurrecting records the operator deliberately deleted is not
    // something an agent should be able to do on a persuasive sentence.
    for (const tool of TOOLS) {
      const json = JSON.stringify(tool.inputSchema);
      expect(json, tool.name).not.toContain('reimport');
      expect(json, tool.name).not.toContain('reimport_deleted');
    }
  });

  it('gives ab_sync no dry_run, because a sync has nothing to preview', () => {
    const syncTool = findTool('ab_sync');
    const properties = (syncTool?.inputSchema.properties ?? {}) as object;
    expect(Object.keys(properties)).not.toContain('dry_run');
  });

  it('gives every OTHER write tool a dry_run', () => {
    for (const tool of TOOLS) {
      if (tool.tier !== 'write' || tool.name === 'ab_sync') {
        continue;
      }
      const properties = (tool.inputSchema.properties ?? {}) as object;
      expect(Object.keys(properties), tool.name).toContain('dry_run');
    }
  });
});
