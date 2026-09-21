ACTUAL BUDGET — MACHINE-PLANE BUILD STATUS

What has actually been BUILT, as opposed to what is specified. Phases are defined in
pm/apis.mdx section 21. Updated by pm/prompts/p_build_api_stack.md, stage 6.

Bracket key:
  [     ]  not started
  [IN-PR]  in progress
  [ DONE]  built, tested, run on a live server, and both clients reach it

[ DONE]  P0   mount, key, gates 1-3, envelope, /ping, fail-closed, mount-order test
              routes: 2 (/ping, /sync planned)   cli verbs: 1
              notes: packages/sync-server/src/machine/ — credentials-file, machine-auth,
                     envelope, index. Mounted before the SPA catch-all in app.ts on purpose.
                     initMachinePlane() called from run(), never at import.

[ DONE]  P1   the engine, the tier gate, input validation, the route registry, and the
              four diagnostic routes
              routes: 5 (/ping /whoami /capabilities /health live, /sync planned)
              tests : 45 new across plane-routes.test.ts + engine.test.ts
                      (src/machine is 66/66, green on every run)
              cli   : abx whoami | capabilities | health [--probe]
              mcp   : ab_whoami and ab_health now reach real routes (were calling
                      routes that did not exist)
              built : 2026-09-20
              verified live on a throwaway server (port 5099, temp data dir):
                * gate ladder: key ok / no key 401 / wrong key identical 401 /
                  valid key + evil Origin 404 / cross-site Sec-Fetch-Site 404 /
                  rebinding Host 404 / unknown route envelope-404
                * engine really initialises inside the sync server (ready in ~70ms)
                * a real budget was created and opened; /health went healthy and
                  meta named it on every response
                * abx and the MCP both answered from that same engine
              decisions taken during the build, now in the spec:
                * schema.ts renamed validate.ts — /schema is also a route name
                * @actual-app/api is a DEVdependency, dynamically imported, so the
                  published sync-server dependency graph is unchanged
                * engine init is LAZY; the four diagnostic routes never require it
                * /health gained ?probe=true to start the engine deliberately
                * routes publish status live|planned so /capabilities cannot lie
                * /schema moved to P2 — the AQL schema is not exposed by
                  @actual-app/api, so it needs the query family's work

[IN-PR]  P2   read families — PARTIAL (the import subset is live)
              live  : GET /budgets, GET /accounts, /accounts/:id, /accounts/:id/balance,
                      GET /transactions
              todo  : categories, budget months, reference data, /query, /schema
[IN-PR]  P3   confirm.ts and the write protocol — LIVE; writes so far: POST /budgets,
              POST /budgets/:id/load, POST /accounts, POST /transactions/import, POST /sync
              todo  : /undo (declared planned), budget amounts, PATCH /transactions
[IN-PR]  P4   ingest plane, prepared mode — LIVE: GET /ingest/manifest,
              POST /ingest/file/plan, POST /ingest/file/apply
              todo  : scan, coverage, map, /ingest/plan + /ingest/apply (many files)
[IN-PR]  P5   account provisioning — LIVE: POST /ingest/accounts/plan, /ingest/accounts/apply
              todo  : the map writer
              built : 2026-09-21
              tests : confirm.test.ts (8), import-routes.test.ts (19); src/machine 93/93
              mcp   : 38 tools (31 read, 7 write); new: ab_get_statement_manifest,
                      ab_plan_accounts, ab_apply_accounts, ab_plan_file_import,
                      ab_apply_file_import. mcp tests 53/53.
              engine: now JOINS the sync server it is mounted in (machine/session.ts mints a
                      never-expiring session row, auth_method 'machine', for the owner), so
                      budgets it creates and imports sync to the browser. Before the server is
                      bootstrapped it runs local-only and /health says so.
              verified live: 12 personal accounts imported through the MCP; every re-plan
                      reported 0 to add; every balance equals the latest printed statement.
[     ]  P6   the envelope operations: cover, transfer, copy, averages, holds, goal templates
[     ]  P7   the analytics plane
[     ]  P8   rules, schedules, payees, tags, notes, /rules/preview, reconcile
[     ]  P9   raw ingest mode: PDF extraction, both de-dupe layers, staging
[     ]  P10  admin tier, batch, NDJSON progress, audit trail, the full canary suite

NEXT: finish P2 (categories, months, /query) so the remaining 28 read tools answer

KNOWN PRE-EXISTING FLAKE IN THE SYNC-SERVER SUITE (not ours — measured)
  `yarn workspace @actual-app/sync-server run test` fails roughly one run in four, on
  src/app-account.test.js (/server-prefs) or src/app-sync.test.ts (/user-create-key).
  The symptom is always an auth answer where a validation answer was expected — a 403
  instead of a 400 — i.e. a session that should exist does not.

  Cause: every test file in the package shares ONE on-disk account.sqlite (see the
  comment in vitest.config.ts about fileParallelism), so state carries across files and
  the result depends on file order.

  Measured, so it is not a guess: with BOTH P1 test files removed from the tree the
  suite still failed 1 run in 4 (644 tests). It is not caused by the machine plane.
  src/machine alone is 66/66 and has never failed.

  Worth fixing on its own ticket: each file should create and tear down its own rows,
  or the suite should get a per-file database.

ENVIRONMENT NOTE (not a code problem, but it will bite again)
  node on this machine is v26.9.0 while .nvmrc pins v24.18.1. better-sqlite3's prebuilt
  binary does not match that node's ABI, so EVERY `yarn install` — including the one
  `just build` runs via `just setup` — leaves the sync-server test suite unable to open
  a database until:
      yarn rebuild better-sqlite3
  Switching to the pinned node (nvm use) is the real fix.

  Also: lage cached `@actual-app/api build` as "skip" while packages/api/dist was
  missing, which presents as "the engine is not installed". `rm -rf .lage` clears it.
