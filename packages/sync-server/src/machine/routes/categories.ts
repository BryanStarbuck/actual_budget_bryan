/**
 * Categories — pm/apis.mdx §8.4, §8.4a (the category tree).
 *
 * `GET /categories/tree` is every category GROUP with its categories nested,
 * in the app's own display order, as a structured tree AND as a YAML document
 * in one answer. The YAML shape is shared with the two sister apps
 * (ezBookkeeping, Firefly III), so an agent that has read one app's tree can
 * read the others' without learning a new format.
 *
 * The server builds both. A client that assembled the tree itself from
 * `/categories` plus `/category-groups` would be a second implementation of
 * "which categories exist, in which order", free to disagree with the app's
 * sidebar — and the YAML is the thing an agent picks categories FROM, so a
 * disagreement there is a transaction filed under a category the operator
 * cannot see.
 *
 * Order is the engine's: `category_groups` sorts by is_income, sort_order, id
 * and `categories` by sort_order, id (loot-core aql/schema). Nothing here
 * re-sorts, so income groups come last exactly as they do in the budget page.
 */
import type { EngineLib } from '#machine/engine';
import { requireBudget } from '#machine/engine';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { fields } from '#machine/validate';
import { Quoted, Timestamp, toYaml } from '#machine/yaml';

const TREE_APP = 'actual_budget';

/** `api/category-groups-get`, verbatim — the engine's external model. */
export type ApiCategoryGroup = {
  id: string;
  name: string;
  is_income: boolean;
  hidden: boolean;
  categories: Array<{
    id: string;
    name: string;
    is_income: boolean;
    hidden: boolean;
    group_id: string;
  }>;
};

type TreeGroup = {
  name: string;
  id: string;
  type: 'expense' | 'income';
  hidden: boolean;
  subcategories: Array<{ name: string; id: string; hidden: boolean }>;
};

type CategoryTree = {
  app: typeof TREE_APP;
  generated_at: string;
  counts: { groups: number; subcategories: number };
  groups: TreeGroup[];
};

type TreeArgs = { include_hidden?: boolean; format?: 'json' | 'yaml' };

/**
 * The groups the engine knows, hidden ones included or not.
 *
 * `hidden: false` asks the engine to drop hidden groups AND hidden categories
 * inside visible groups (budget/app.ts getCategoryGroups); omitting it returns
 * everything. Filtering here instead would be a second definition of hidden.
 */
export async function categoryGroups(
  lib: EngineLib,
  includeHidden: boolean,
): Promise<ApiCategoryGroup[]> {
  return (await lib.send(
    'api/category-groups-get',
    includeHidden ? {} : { hidden: false },
  )) as ApiCategoryGroup[];
}

/** The ISO timestamp without milliseconds: `2026-09-21T22:00:00Z`. */
function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildTree(groups: ApiCategoryGroup[], now: Date): CategoryTree {
  const tree: TreeGroup[] = groups.map(g => ({
    name: g.name,
    id: g.id,
    type: g.is_income ? 'income' : 'expense',
    hidden: Boolean(g.hidden),
    subcategories: (g.categories ?? []).map(c => ({
      name: c.name,
      id: c.id,
      hidden: Boolean(c.hidden),
    })),
  }));
  return {
    app: TREE_APP,
    generated_at: stamp(now),
    counts: {
      groups: tree.length,
      subcategories: tree.reduce((n, g) => n + g.subcategories.length, 0),
    },
    groups: tree,
  };
}

/**
 * The tree as the shared YAML document. Key order is part of the contract —
 * name, type, id, hidden, subcategories — because the three sister apps are
 * diffed against each other by eye.
 */
export function treeYaml(tree: CategoryTree): string {
  return toYaml({
    app: tree.app,
    generated_at: new Timestamp(tree.generated_at),
    counts: tree.counts,
    groups: tree.groups.map(g => ({
      name: g.name,
      type: g.type,
      id: new Quoted(g.id),
      hidden: g.hidden,
      subcategories: g.subcategories.map(c => ({
        name: c.name,
        id: new Quoted(c.id),
        hidden: c.hidden,
      })),
    })),
  });
}

export const categoryRoutes: AnyRouteDef[] = [
  route<TreeArgs>({
    method: 'GET',
    path: '/categories/tree',
    tier: 'read',
    summary:
      'Every category group with its categories nested, in display order, as a structured tree plus the same tree as a YAML document (data.yaml). Hidden excluded unless include_hidden.',
    status: 'live',
    needsEngine: true,
    validate: fields<TreeArgs>({
      include_hidden: { type: 'boolean' },
      format: { type: 'string', enum: ['json', 'yaml'] },
    }),
    run: async ctx => {
      const { include_hidden = false, format = 'json' } = ctx.args;
      const { lib, budget } = await requireBudget(ctx.env);
      const tree = buildTree(
        await categoryGroups(lib, include_hidden),
        new Date(),
      );
      const yaml = treeYaml(tree);
      const meta = { budgetId: budget.id, budgetName: budget.name };
      // Everything on this plane answers in the envelope (index.ts), so
      // format=yaml does not change the content type: it drops the structured
      // groups and leaves the document, for `| jq -r .data.yaml`.
      if (format === 'yaml') {
        return { data: { app: tree.app, counts: tree.counts, yaml }, meta };
      }
      return { data: { ...tree, yaml }, meta };
    },
  }),
];
