ACTUAL BUDGET — MACHINE-PLANE BUILD STATUS

What has actually been BUILT, as opposed to what is specified. Phases are defined in
pm/apis.mdx section 21. Updated by pm/prompts/p_build_api_stack.md, stage 6.

Bracket key:
[ ] not started
[IN-PR] in progress
[ DONE] built, tested, run on a live server, and both clients reach it

[ DONE] P0 mount, key, gates 1-3, envelope, /ping, fail-closed, mount-order test
routes: 2 (/ping, /sync stub) tests: 4 files cli verbs: 1 mcp tools: 0
notes: packages/sync-server/src/machine/ — credentials-file, machine-auth,
envelope, index. Mounted before the SPA catch-all in app.ts on purpose.
initMachinePlane() called from run(), never at import.

[ ] P1 engine.ts (the one @actual-app/api instance), tier.ts, schema.ts,
/whoami, /capabilities, /health, /schema
[ ] P2 read families: accounts, transactions, categories, budget months, reference, /query
[ ] P3 confirm.ts and the write protocol; transactions, budget amounts, /sync, /undo
[ ] P4 ingest plane, prepared mode: manifest, scan, coverage, map, plan, apply, file import
[ ] P5 account provisioning and the map writer
[ ] P6 the envelope operations: cover, transfer, copy, averages, holds, goal templates
[ ] P7 the analytics plane
[ ] P8 rules, schedules, payees, tags, notes, /rules/preview, reconcile
[ ] P9 raw ingest mode: PDF extraction, both de-dupe layers, staging
[ ] P10 admin tier, batch, NDJSON progress, audit trail, the full canary suite

NEXT: P1
