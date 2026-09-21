/**
 * The category verbs — pm/cli.mdx §8, over pm/apis.mdx §8.4a.
 *
 * `abx categories tree` prints the server's YAML document as-is. The tree and
 * its YAML are both built by the machine plane; nothing here assembles,
 * sorts or re-quotes it, so the CLI, the MCP and the two sister apps' trees
 * all read the same text.
 */
import { getBoolean, getString } from '../args.js';
import { call } from '../client.js';
import { out, render } from '../render.js';
import type { Row } from '../render.js';
import type { Context, Verb } from '../verb.js';

type Tree = {
  groups: Array<{
    name: string;
    id: string;
    type: string;
    hidden: boolean;
    subcategories: Array<{ name: string; id: string; hidden: boolean }>;
  }>;
  yaml: string;
};

export const categoriesTree: Verb = {
  name: 'categories tree',
  summary:
    'every category group with its categories, as YAML (--format json|table|csv for the rest)',
  flags: {
    'include-hidden': {
      arity: 'boolean',
      help: 'include hidden groups and categories',
    },
  },
  async run(ctx: Context): Promise<number> {
    const includeHidden = getBoolean(ctx.args, 'include-hidden');
    const envelope = await call(
      ctx.target,
      ctx.requireKey(),
      `/categories/tree${includeHidden ? '?include_hidden=true' : ''}`,
      { timeoutMs: 30_000, logger: ctx.logger, verb: 'categories tree' },
    );
    const tree = (envelope as { data: Tree }).data;

    // YAML is this verb's default payload, so `abx categories tree > tree.yaml`
    // is the whole document and nothing else. An explicit --format still wins.
    if (getString(ctx.args, 'format') === undefined) {
      out(tree.yaml);
      return 0;
    }

    const rows: Row[] = tree.groups.flatMap(g =>
      g.subcategories.map(c => ({
        group: g.name,
        category: c.name,
        type: g.type,
        hidden: g.hidden || c.hidden ? 'hidden' : '',
        id: c.id,
      })),
    );
    out(
      render(ctx.format, envelope, rows, [
        { key: 'group', header: 'GROUP' },
        { key: 'category', header: 'CATEGORY' },
        { key: 'type', header: 'TYPE' },
        { key: 'hidden', header: 'HIDDEN' },
        { key: 'id', header: 'ID' },
      ]),
    );
    return 0;
  },
};
