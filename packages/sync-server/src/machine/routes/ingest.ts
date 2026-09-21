/**
 * The ingest plane, `prepared` mode — pm/apis.mdx §11; pm/import_formats.mdx §3, §11.
 *
 * A prepared tree already holds importable files and a manifest describing
 * them. This plane treats that tree as STRICTLY READ-ONLY: it never writes
 * into it, never moves a file, never rewrites the manifest (§11.1).
 *
 * `/ingest/file/plan` hands one file to Actual's OWN parser
 * (`transactions-parse-file`) and then to the importer's dry run. Only the
 * id-carrying formats are accepted — OFX/QFX and CAMT XML — because a CSV
 * needs a column mapping the plane does not take and a QIF needs a date
 * order, and either imported without an id de-duplicates only by fuzzy match
 * (import_formats.mdx §4.6, §8.3). Say so, rather than import it badly.
 *
 * `/ingest/file/apply` takes the token, recomputes the plan from the token's
 * own payload (so it cannot be pointed at a different file than the one the
 * operator saw), compares fingerprints, and only then writes — and then syncs,
 * so the browser sees it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { fingerprintOf, issueConfirm, peekConfirm, redeemConfirm } from '#machine/confirm';
import { readStatementsRoot } from '#machine/credentials-file';
import type { EngineLib } from '#machine/engine';
import { requireBudget } from '#machine/engine';
import { MachineError } from '#machine/envelope';
import {
  applyImport,
  assertUnderCeiling,
  previewImport,
  resolveAccount,
} from '#machine/import-plan';
import type { ImportOptions, ImportRow } from '#machine/import-plan';
import { route } from '#machine/route';
import type { AnyRouteDef } from '#machine/route';
import { MAX_CHANGES_DEFAULT } from '#machine/routes/plane';
import { fields } from '#machine/validate';

import { syncIfConnected } from './budgets.js';
import { importOptionsFrom } from './transactions.js';

const ACCEPTED = new Set(['.ofx', '.qfx', '.xml']);
const REFUSED_WITH_REASON: Record<string, string> = {
  '.csv': 'a CSV carries no imported_id and needs a column mapping — import the OFX beside it (import_formats.mdx §4.6)',
  '.tsv': 'a TSV carries no imported_id and needs a column mapping — import the OFX beside it',
  '.qif': 'a QIF carries no imported_id and needs a date order — import the OFX beside it (import_formats.mdx §5)',
};

const REQUIRED_MANIFEST_COLUMNS = ['entity', 'institution', 'label', 'last4', 'kind', 'path'];

type ManifestArgs = { root?: string; manifest_path?: string };
type PlanArgs = {
  account_id: string;
  path: string;
  import_notes?: boolean;
  max_changes?: number;
  reimport_deleted?: boolean;
  payee_name_normalization?: 'original' | 'title-case';
};
type ApplyArgs = { confirm_token: string; dry_run?: boolean };

type PlanPayload = {
  account_id: string;
  path: string;
  import_notes: boolean;
  max_changes: number;
  options: ImportOptions;
};

type ParsedRow = {
  amount: number;
  date: string;
  payee_name?: string | null;
  imported_payee?: string | null;
  imported_id?: string;
  notes?: string | null;
};

function statementsRoot(env: NodeJS.ProcessEnv, override?: string): string {
  const root = override ?? env.ABX_STATEMENTS_DIR ?? readStatementsRoot(env);
  if (!root) {
    throw new MachineError(
      'invalid_input',
      'No statements root is configured.',
      'pass root, or set ABX_STATEMENTS_DIR, or put actual_budget.statements.root in ~/.credentials/actual_budget.json',
    );
  }
  return root;
}

/** A small RFC-4180 reader: quoted fields, doubled quotes, CRLF. No dependency. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') {
        i += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function checkedFile(filePath: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new MachineError('invalid_input', 'path must be absolute.', 'give the full path to the file');
  }
  const resolved = path.resolve(filePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new MachineError('not_found', `No file at ${resolved}.`);
  }
  if (!stat.isFile()) {
    throw new MachineError('invalid_input', `${resolved} is not a file.`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ACCEPTED.has(ext)) {
    throw new MachineError(
      'invalid_input',
      `${ext || 'a file with no extension'} cannot be imported through this route.`,
      REFUSED_WITH_REASON[ext] ?? 'accepted: .ofx, .qfx, .xml (CAMT)',
    );
  }
  return resolved;
}

/** Actual's own parser, then the §2 contract: cents, and the parser's errors refuse the plan. */
async function parseRows(
  lib: EngineLib,
  filePath: string,
  importNotes: boolean,
): Promise<ImportRow[]> {
  const parsed = (await lib.send('transactions-parse-file', {
    filepath: filePath,
    options: { importNotes, fallbackMissingPayeeToMemo: true },
  })) as { errors: Array<{ message: string }>; transactions?: ParsedRow[] };

  if (parsed.errors.length > 0) {
    // import_formats.mdx §13.2: an unparseable amount would import as zero.
    throw new MachineError(
      'invalid_input',
      `Actual's parser reported ${parsed.errors.length} problem${parsed.errors.length > 1 ? 's' : ''} with ${path.basename(filePath)}: ${parsed.errors
        .slice(0, 3)
        .map(e => e.message)
        .join('; ')}.`,
      'fix the file — nothing is imported from a file the parser could not fully read',
    );
  }

  return (parsed.transactions ?? []).map(t => {
    const row: ImportRow = { date: t.date, amount: Math.round(t.amount * 100) };
    if (t.payee_name) row.payee_name = t.payee_name;
    if (t.imported_payee) row.imported_payee = t.imported_payee;
    if (t.imported_id) row.imported_id = t.imported_id;
    if (t.notes) row.notes = t.notes;
    return row;
  });
}

async function plan(
  env: NodeJS.ProcessEnv,
  payload: PlanPayload,
): Promise<{
  data: Record<string, unknown>;
  fp: string;
  rows: ImportRow[];
  lib: EngineLib;
  meta: Record<string, unknown>;
}> {
  const { lib, budget } = await requireBudget(env);
  const account = await resolveAccount(lib, payload.account_id);
  const rows = await parseRows(lib, payload.path, payload.import_notes);
  const withoutId = rows.filter(r => !r.imported_id).length;
  const preview = await previewImport(lib, payload.account_id, rows, payload.options);
  const fp = fingerprintOf(preview.changeSet);
  return {
    lib,
    rows,
    fp,
    data: {
      account,
      file: payload.path,
      rows: rows.length,
      rows_without_imported_id: withoutId,
      date_range:
        rows.length === 0
          ? null
          : {
              first: rows.reduce((a, r) => (r.date < a ? r.date : a), rows[0].date),
              last: rows.reduce((a, r) => (r.date > a ? r.date : a), rows[0].date),
            },
      options: { ...payload.options, import_notes: payload.import_notes },
      max_changes: payload.max_changes,
      changes: preview.changes,
    },
    meta: { budgetId: budget.id, budgetName: budget.name },
  };
}

type ManifestRow = Record<string, string>;

function readManifest(
  env: NodeJS.ProcessEnv,
  rootArg?: string,
  manifestArg?: string,
): { root: string; rel: string; dir: string; header: string[]; missing: string[]; rows: ManifestRow[] } {
  const root = statementsRoot(env, rootArg);
  const rel = manifestArg ?? 'import/personal/manifest_actual.csv';
  const file = path.resolve(root, rel);
  if (!file.startsWith(path.resolve(root) + path.sep)) {
    throw new MachineError('invalid_input', 'manifest_path must be inside root.');
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new MachineError('not_found', `No manifest at ${file}.`, 'pass manifest_path relative to root');
  }
  const table = parseCsv(text);
  if (table.length === 0) {
    throw new MachineError('invalid_input', `${file} is empty.`);
  }
  const header = table[0].map(h => h.trim());
  const missing = REQUIRED_MANIFEST_COLUMNS.filter(c => !header.includes(c));
  const rows = table.slice(1).map(cells => {
    const row: ManifestRow = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? '';
    });
    return row;
  });
  return { root, rel, dir: path.dirname(file), header, missing, rows };
}

// ---- account provisioning from the manifest — pm/apis.mdx §12 ----

/** §12.3: which kinds live on-budget by default. Everything else is off-budget. */
const ON_BUDGET_KINDS_DEFAULT = ['checking', 'savings', 'card'];

/**
 * The display name for a manifest row.
 *
 * The template's placeholders: {Entity} {Institution} {Kind} {Account} {last4}
 * {label}. {Account} is the manifest's `type` column read as a person would
 * ("Checking_x4021" → "Checking ••4021", "401k" → "401k"), falling back to
 * `{Kind} ••{last4}`. The default keeps the institution and the account,
 * which for a single-entity archive is what a statement prints; a
 * multi-entity archive passes naming "{Entity} · {Institution} {Account}".
 */
const NAMING_DEFAULT = '{Institution} {Account}';

function accountWord(row: ManifestRow): string {
  const type = row.type ?? '';
  const m = type.match(/^(.*?)_x(\d{4})$/);
  if (m) {
    return `${m[1].replace(/_/g, ' ')} ••${m[2]}`;
  }
  if (type) {
    return type.replace(/_/g, ' ');
  }
  const kind = (row.kind ?? 'account').replace(/^./, c => c.toUpperCase());
  return row.last4 ? `${kind} ••${row.last4}` : kind;
}

function nameFor(row: ManifestRow, naming: string): string {
  return naming
    .replace(/\{Entity\}/g, row.entity ?? '')
    .replace(/\{Institution\}/g, (row.institution ?? '').replace(/_/g, ' '))
    .replace(/\{Kind\}/g, (row.kind ?? '').replace(/^./, c => c.toUpperCase()))
    .replace(/\{Account\}/g, accountWord(row))
    .replace(/\{last4\}/g, row.last4 ?? '')
    .replace(/\{label\}/g, row.label ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

type AccountPlanRow = {
  manifest: ManifestRow;
  action: 'create' | 'link' | 'ambiguous';
  proposed?: { name: string; offbudget: boolean };
  existing?: { id: string; name: string };
  candidates?: Array<{ id: string; name: string }>;
  reason: string;
};

type AccountsPlanArgs = {
  root?: string;
  manifest_path?: string;
  naming?: string;
  on_budget_kinds?: unknown[];
  import_group?: string;
  dry_run?: boolean;
  confirm_token?: string;
};

async function planAccounts(
  env: NodeJS.ProcessEnv,
  args: AccountsPlanArgs,
): Promise<{
  lib: EngineLib;
  meta: Record<string, unknown>;
  data: { plan: AccountPlanRow[]; summary: Record<string, number>; naming: string; on_budget_kinds: string[]; manifest_path: string };
}> {
  const { lib, budget } = await requireBudget(env);
  const manifest = readManifest(env, args.root, args.manifest_path);
  if (manifest.missing.length > 0) {
    throw new MachineError(
      'invalid_input',
      `The manifest is missing required column${manifest.missing.length > 1 ? 's' : ''}: ${manifest.missing.join(', ')}.`,
      `a manifest needs: ${REQUIRED_MANIFEST_COLUMNS.join(', ')}`,
    );
  }
  const naming = args.naming ?? NAMING_DEFAULT;
  const onBudget = (args.on_budget_kinds ?? ON_BUDGET_KINDS_DEFAULT).map(String);
  const existing = (await lib.send('api/accounts-get')) as Array<{ id: string; name: string; closed: boolean }>;

  const rows = args.import_group
    ? manifest.rows.filter(r => (r.import_group ?? '') === args.import_group)
    : manifest.rows;

  const plan: AccountPlanRow[] = rows.map(row => {
    const name = nameFor(row, naming);
    const byName = existing.filter(a => a.name.trim().toLowerCase() === name.toLowerCase());
    const byLast4 = row.last4
      ? existing.filter(a => a.name.includes(`••${row.last4}`) || a.name.endsWith(row.last4))
      : [];
    const matches = [...new Map([...byName, ...byLast4].map(a => [a.id, a])).values()];
    if (matches.length === 1) {
      return {
        manifest: row,
        action: 'link',
        existing: { id: matches[0].id, name: matches[0].name },
        reason: byName.length === 1 ? 'matched on name' : `matched on last4 ${row.last4}`,
      };
    }
    if (matches.length > 1) {
      return {
        manifest: row,
        action: 'ambiguous',
        candidates: matches.map(a => ({ id: a.id, name: a.name })),
        reason: `${matches.length} existing accounts match on name or last4 — resolve by hand, this is never created`,
      };
    }
    const offbudget = !onBudget.includes(row.kind ?? '');
    return {
      manifest: row,
      action: 'create',
      proposed: { name, offbudget },
      reason: `no existing account matched on last4 or name; kind=${row.kind} → ${offbudget ? 'off' : 'on'}-budget by the on_budget_kinds rule`,
    };
  });

  const summary = { create: 0, link: 0, ambiguous: 0 };
  for (const p of plan) {
    summary[p.action] += 1;
  }
  return {
    lib,
    meta: { budgetId: budget.id, budgetName: budget.name },
    data: { plan, summary, naming, on_budget_kinds: onBudget, manifest_path: manifest.rel },
  };
}

const accountsPlanFields = {
  root: { type: 'string', maxLength: 1024 },
  manifest_path: { type: 'string', maxLength: 1024 },
  naming: { type: 'string', maxLength: 200 },
  on_budget_kinds: { type: 'array', maxItems: 20 },
  import_group: { type: 'string', maxLength: 40 },
} as const;

/** What the token fingerprints: every row's decision, never the reasons' prose. */
function accountsChangeSet(plan: AccountPlanRow[]): unknown {
  return plan.map(p => [p.manifest.label, p.action, p.proposed ?? null, p.existing?.id ?? null]);
}

export const ingestRoutes: AnyRouteDef[] = [
  route<AccountsPlanArgs>({
    method: 'POST',
    path: '/ingest/accounts/plan',
    tier: 'read',
    summary:
      'For every manifest row: create, link to an existing account, or ambiguous — with the reasoning and the on/off-budget decision. Creates nothing. Returns a confirm_token for apply.',
    status: 'live',
    needsEngine: true,
    validate: fields<AccountsPlanArgs>({ ...accountsPlanFields }),
    run: async ctx => {
      const result = await planAccounts(ctx.env, ctx.args);
      const fp = fingerprintOf(accountsChangeSet(result.data.plan));
      return {
        data: { dry_run: true, ...result.data, ...issueConfirm('ingest.accounts', fp, ctx.args) },
        meta: result.meta,
      };
    },
  }),

  route<{ confirm_token: string; dry_run?: boolean }>({
    method: 'POST',
    path: '/ingest/accounts/apply',
    tier: 'write',
    summary:
      'Create the accounts a plan token was issued for. The plan is recomputed and must match. Ambiguous rows are never created. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<{ confirm_token: string; dry_run?: boolean }>({
      confirm_token: { type: 'string', required: true },
      dry_run: { type: 'boolean' },
    }),
    run: async ctx => {
      const { confirm_token, dry_run = true } = ctx.args;
      const entry = peekConfirm(confirm_token, 'ingest.accounts');
      const result = await planAccounts(ctx.env, entry.payload as AccountsPlanArgs);
      const fp = fingerprintOf(accountsChangeSet(result.data.plan));
      if (dry_run) {
        return { data: { dry_run: true, ...result.data, confirm_token, fingerprint: fp }, meta: result.meta };
      }
      redeemConfirm(confirm_token, 'ingest.accounts', fp, result.data.summary);

      const created: Array<{ manifest: ManifestRow; id: string; name: string; offbudget: boolean }> = [];
      for (const p of result.data.plan) {
        if (p.action !== 'create' || !p.proposed) {
          continue;
        }
        const id = (await result.lib.send('api/account-create', {
          account: { name: p.proposed.name, offbudget: p.proposed.offbudget, closed: false },
          initialBalance: null,
        })) as string;
        created.push({ manifest: p.manifest, id, name: p.proposed.name, offbudget: p.proposed.offbudget });
      }
      const sync = await syncIfConnected(ctx.env);
      return {
        data: {
          dry_run: false,
          created,
          linked: result.data.plan
            .filter(p => p.action === 'link')
            .map(p => ({ manifest: p.manifest, ...p.existing })),
          ambiguous: result.data.plan.filter(p => p.action === 'ambiguous'),
          sync,
        },
        meta: result.meta,
      };
    },
  }),

  route<ManifestArgs>({
    method: 'GET',
    path: '/ingest/manifest',
    tier: 'read',
    summary:
      "Read a prepared tree's manifest: one row per account with its importable files. Reports missing columns rather than guessing.",
    status: 'live',
    needsEngine: false,
    validate: fields<ManifestArgs>({
      root: { type: 'string', maxLength: 1024 },
      manifest_path: { type: 'string', maxLength: 1024 },
    }),
    run: async ctx => {
      const manifest = readManifest(ctx.env, ctx.args.root, ctx.args.manifest_path);
      const accounts = manifest.rows.map(row => {
        // Manifest paths are relative to the manifest's own directory.
        const dir = row.path ? path.resolve(manifest.dir, row.path) : null;
        const combined = row.combined_ofx ? path.resolve(manifest.dir, row.combined_ofx) : null;
        return {
          ...row,
          absolute_path: dir,
          combined_ofx_absolute: combined,
          combined_ofx_exists: combined ? fs.existsSync(combined) : false,
        };
      });
      return {
        data: {
          root: manifest.root,
          manifest_path: manifest.rel,
          mode: 'prepared',
          columns: manifest.header,
          missing_columns: manifest.missing,
          accounts,
          totals: { accounts: accounts.length },
        },
      };
    },
  }),

  route<PlanArgs>({
    method: 'POST',
    path: '/ingest/file/plan',
    tier: 'read',
    summary:
      "Parse one OFX/QFX/CAMT file with Actual's own parser and run the importer's dry run against an account. Returns the counts and a confirm_token. Changes nothing.",
    status: 'live',
    needsEngine: true,
    validate: fields<PlanArgs>({
      account_id: { type: 'string', required: true },
      path: { type: 'string', required: true, maxLength: 1024 },
      import_notes: { type: 'boolean' },
      max_changes: { type: 'integer', min: 1 },
      reimport_deleted: { type: 'boolean' },
      payee_name_normalization: { type: 'string', enum: ['original', 'title-case'] },
    }),
    run: async ctx => {
      const payload: PlanPayload = {
        account_id: ctx.args.account_id,
        path: checkedFile(ctx.args.path),
        import_notes: ctx.args.import_notes ?? true,
        max_changes: ctx.args.max_changes ?? MAX_CHANGES_DEFAULT,
        options: importOptionsFrom(ctx.args),
      };
      const result = await plan(ctx.env, payload);
      return {
        data: {
          dry_run: true,
          ...result.data,
          ...issueConfirm('ingest.file', result.fp, payload),
        },
        meta: result.meta,
      };
    },
  }),

  route<ApplyArgs>({
    method: 'POST',
    path: '/ingest/file/apply',
    tier: 'write',
    summary:
      'Import the file a plan token was issued for. The plan is recomputed and must match; then the rows are written and the budget synced. dry_run defaults true.',
    status: 'live',
    needsEngine: true,
    validate: fields<ApplyArgs>({
      confirm_token: { type: 'string', required: true },
      dry_run: { type: 'boolean' },
    }),
    run: async ctx => {
      const { confirm_token, dry_run = true } = ctx.args;
      const entry = peekConfirm(confirm_token, 'ingest.file');
      const payload = entry.payload as PlanPayload;
      const result = await plan(ctx.env, payload);
      if (dry_run) {
        return {
          data: { dry_run: true, ...result.data, confirm_token, fingerprint: result.fp },
          meta: result.meta,
        };
      }
      redeemConfirm(confirm_token, 'ingest.file', result.fp, result.data.changes);
      assertUnderCeiling(result.data.changes as never, payload.max_changes);
      const applied = await applyImport(result.lib, payload.account_id, result.rows, payload.options);
      const sync = await syncIfConnected(ctx.env);
      return {
        data: {
          dry_run: false,
          ...result.data,
          changes: {
            added: applied.added,
            updated: applied.updated,
            unchanged: applied.unchanged,
            errors: applied.errors,
          },
          sync,
        },
        meta: result.meta,
      };
    },
  }),
];
