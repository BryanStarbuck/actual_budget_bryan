ROOT_DIR dir is ~/BGit/Bryan_git/actual_budget_bryan

API_SPEC is file {ROOT_DIR}/pm/apis.mdx

MCP_SPEC is file {ROOT_DIR}/pm/mcp.mdx

CLI_SPEC is file {ROOT_DIR}/pm/cli.mdx

MCP_PROMPT_FILE is file {ROOT_DIR}/ai/mcp_prompt.md

PLANE_DIR dir is {ROOT_DIR}/packages/sync-server/src/machine

MCP_DIR dir is {ROOT_DIR}/mcp

CLI_DIR dir is {ROOT_DIR}/cli

APP_MOUNT_FILE is file {ROOT_DIR}/packages/sync-server/src/app.ts

ENGINE_METHODS_FILE is file {ROOT_DIR}/packages/api/methods.ts

JUSTFILE is file {ROOT_DIR}/justfile

STATUS_FILE is file {ROOT_DIR}/pm/prompts/Build_Status.md

THE_DATE_TIME_STRING is the string "{Date}_{Time}_" where it uses "_" instead of any special characters, so it is purely alphanumeric or underscores.

THE_LOG_FILE is the file ~/T/_actual_budget/{THE_DATE_TIME_STRING}_build_api_stack.log

CREDENTIALS_FILE is file ~/.credentials/actual_budget.json

STATEMENTS_ROOT is the directory named in CREDENTIALS_FILE under actual_budget.statements.root
  * NEVER hardcode that path into this prompt, into any spec, or into any source file. It is the
    operator's private financial archive and this repo is going open source.
  * If it is not set, ask the operator for it once and write it into CREDENTIALS_FILE.

THE_PHASE_TO_BUILD is the phase identifier: P1
  * Use that value unless a different phase is already specified when this prompt is run.
  * Phases are defined in API_SPEC section 21.


Goal of this prompt = Build one phase of the machine-plane API into the web app, prove it runs,
then bring the MCP and the CLI up onto it, and leave the specs and the status file true.

This is a BUILD AND RUN prompt, not a design prompt. The design is already written down. API_SPEC
is the contract, MCP_SPEC and CLI_SPEC are its two clients, and MCP_PROMPT_FILE is what the model
on the other end reads. Where this prompt and API_SPEC disagree, API_SPEC is right.

Build one phase per run. A phase that is built, tested, run and reported is worth more than three
phases that are half written.

Create this file if it does not exist: THE_LOG_FILE

Create this file if it does not exist: STATUS_FILE


====================================================================
STAGE 0 — ORIENT BEFORE TOUCHING ANYTHING
====================================================================

* Read API_SPEC in full. It is long. Read it anyway; every later stage refers back to it by section
  number and guessing costs more than reading.

* Read the section of API_SPEC named "21. Build phases" and find the row for THE_PHASE_TO_BUILD.
  That row names what ships and what it depends on.

* Read STATUS_FILE. It is the record of what has actually been built, as opposed to what is
  specified. If a phase THE_PHASE_TO_BUILD depends on is not marked done there, STOP and say so:
    Output to stdout:
      "--------------------------------------------------------------"
      "BLOCKED: {THE_PHASE_TO_BUILD} depends on {phase}, which is not built."
      "Run this prompt with THE_PHASE_TO_BUILD = {phase} first."
      "--------------------------------------------------------------"

* Read what already exists, so nothing is rewritten that is already right:
  * Every file under PLANE_DIR
  * APP_MOUNT_FILE, specifically where the machine plane is mounted and where initMachinePlane is
    called
  * ENGINE_METHODS_FILE — this is the engine surface the routes are built on
  * The loot-core server handler names, which are a much larger surface than ENGINE_METHODS_FILE
    exposes. Look in {ROOT_DIR}/packages/loot-core/src/server/*/app.ts for app.method(...) calls.
    The envelope-budgeting operations live there and nowhere else.

* Confirm the toolchain works before writing code, not after:
  * cd {ROOT_DIR} && just build
  * If it fails, fix the build first and log what was wrong. A phase built on a broken build is a
    phase nobody can verify.


====================================================================
STAGE 1 — WRITE THE ROUTES
====================================================================

For each route in THE_PHASE_TO_BUILD, in the order API_SPEC lists them:

* Put the handler in the file API_SPEC section 3.1 says it goes in. Do not invent a new file layout.

* Obey the ten design rules in API_SPEC section 2. In particular:
  * One engine call per route. If a route seems to need two, either it is two routes or the
    engine needs one new operation. A composed route is allowed ONLY if API_SPEC names it as one.
  * Money is an integer number of cents in every argument and every field. No floats, no decimal
    strings, no exceptions.
  * Absent is not zero. A category with no budget entry returns null.
  * Every write defaults to dry_run true, and the preview is the write with one boolean different.
    Never write a second function that predicts what the first one will do.
  * Every cap is reported with truncated and limit_applied.
  * Every error names a fix in its hint.

* Write the input schema as a hand-authored validator, one per route, in the file section 3.1
  names. Unknown top-level fields are REJECTED, not ignored.

* Add the route to the single array that both the router and GET /capabilities are built from.
  There is no second list. If you find yourself adding a route name in two places, that is the bug.

* Write the tests as you go, from the table in API_SPEC section 18. Do not batch the tests to the
  end of the phase.


====================================================================
STAGE 2 — BUILD AND RUN, AS NEEDED
====================================================================

This is the loop. Run it as many times as it takes. Do not report a route as done until it has
answered a real request on a running server.

* Build:
    cd {ROOT_DIR} && just build

* Start the server detached, so the loop is not blocked:
    cd {ROOT_DIR} && just server-bg

* Confirm the plane is armed. The boot line says so; look for it in the server log:
    "Machine plane armed on /machine/v1 (key ..., writes ...)"
  * If it is missing, the plane did not initialise. Read the log rather than guessing.

* Prove the gate ladder is intact before trusting any route result:
    * With the key: GET /machine/v1/ping returns ok true.
    * With no key: returns 401 with a constant body.
    * With Origin: https://evil.example and a VALID key: returns 404.
  * If any of those three is wrong, STOP. Every later result is meaningless.

* Exercise each new route by hand with curl, reading the key from CREDENTIALS_FILE. Read the whole
  envelope, not just the status code. Check meta.budget_name is the budget you think it is.

* When a route is wrong, fix it and go back to the top of this stage. Build and run again.

* Run the tests:
    cd {ROOT_DIR} && yarn test
    cd {ROOT_DIR} && yarn typecheck
    cd {ROOT_DIR} && yarn lint:fix

* Take the server down when the loop is finished:
    cd {ROOT_DIR} && just stop


====================================================================
STAGE 3 — BRING THE CLIENTS UP ONTO THE NEW ROUTES
====================================================================

A route with no caller is a route nobody notices is broken. Every phase ends with both clients able
to reach what it added.

* THE CLI, in CLI_DIR:
  * Add the verb CLI_SPEC names for each new route.
  * The CLI owns argument parsing, output formatting and bring-up, and owns no budget logic. It
    never re-filters, re-sums or rounds. The only conversion it is allowed is cents to a decimal
    string for --format table and --format csv, in exactly one function.
  * stdout carries the answer. Everything else is stderr.

* THE MCP, in MCP_DIR:
  * Add the tool MCP_SPEC section 9.5 names for each new route. One tool, one route.
  * Write the description with all four mandatory clauses from MCP_SPEC section 9.2: what it does,
    what it costs, which sibling to use instead, and which server this is.
  * Add it to the one array that tools/list and dispatch both read.
  * If the new route is a write, it needs the dry run, the confirm token and the ceiling. There is
    no write tool without all three.

* MCP_PROMPT_FILE:
  * If the phase added a family the model would not otherwise know to reach for, add it to the
    playbooks. Keep the split: MCP_SPEC says which tools exist, MCP_PROMPT_FILE says when to reach
    for them and how to talk about the answer.
  * Every ab_ tool name mentioned in MCP_PROMPT_FILE must exist. Check it.
  * Put NO private path, NO account name, NO entity name and NO amount in that file. It ships in a
    public repo.


====================================================================
STAGE 4 — PROVE IT AGAINST REAL DATA, WITHOUT TOUCHING REAL DATA
====================================================================

* Run the fixture suite first. Synthetic statements, invented banks, invented amounts. This is what
  CI runs and it must be green.

* Then, if and only if the operator asks for it, point the ingest routes at STATEMENTS_ROOT in READ
  mode only:
  * GET /machine/v1/ingest/manifest
  * POST /machine/v1/ingest/accounts/plan
  * POST /machine/v1/ingest/plan
  * Every one of those changes nothing. Report the counts.

* NEVER write into STATEMENTS_ROOT. It is audit evidence. The only directory this system writes
  under it is the staging directory, and if that would collide with a directory the archive already
  owns, the route must refuse with conflict rather than stage over it.

* NEVER run an apply against the operator's real budget without them asking in that run.


====================================================================
STAGE 5 — THE OPEN-SOURCE AND SAFETY CANARIES
====================================================================

Run these every phase, not just at the end. They are cheap and they catch the mistakes that are
expensive to unwind after a push.

* No secret in the tree:
    grep -rE "[0-9a-f]{32,}" on the built output of PLANE_DIR, MCP_DIR and CLI_DIR

* No private path in the code:
    grep -r "/Users/" and the operator's entity names, across source, excluding fixtures and
    documentation comments

* No financial data in the repo:
    git status, and confirm nothing under the statements root or the staging directory is tracked

* No float arithmetic on money:
    grep -r "parseFloat\|toFixed\|Number(" across the plane's handlers, outside the one conversion
    module

* No leak in a response:
    call every route in GET /machine/v1/capabilities against the fixture budget and grep every
    response for the key pattern, for "secret", for "password" and for "/Users/"

If any canary fails, fix it before the phase is reported done. A canary failure is not a warning.


====================================================================
STAGE 6 — UPDATE THE RECORD
====================================================================

* Update STATUS_FILE. One row per phase, using bracket notation so the state is scannable:
    [     ]  not started
    [IN-PR]  in progress
    [ DONE]  built, tested, run, and both clients reach it

  Row format:
    [ DONE]  P1  the engine instance, tiers, schemas, /whoami /capabilities /health /schema
             routes: 5   tests: 14   cli verbs: 2   mcp tools: 4
             built: {Date}   notes: ...

* If the build revealed that API_SPEC is wrong, FIX API_SPEC. The spec is the contract and a spec
  that disagrees with the working code is worse than no spec. Say in the log what changed and why.
  Do not silently diverge.

* If a route turned out to need a calculation nobody anticipated, add it to API_SPEC as a route
  before adding it to a client as a calculation. That is the rule the whole architecture rests on.

* Update the coverage matrix in API_SPEC section 9 if the phase filled a cell.

* Append to THE_LOG_FILE: the phase, the routes built, the test counts, the canary results, and
  anything left undone.


====================================================================
STAGE 7 — COMMIT
====================================================================

* Follow the repo's own rules, which are not optional here:
  * Commit message and PR title start with [AI]
  * The PR template is left BLANK. Do not fill it in.
  * Do not create a GitHub issue.
  * Do not create, switch or push a branch. Work on the current branch.
  * Add a release note in {ROOT_DIR}/upcoming-release-notes/ with a short descriptive slug.

* Run before committing:
    cd {ROOT_DIR} && yarn typecheck
    cd {ROOT_DIR} && yarn lint:fix
    cd {ROOT_DIR} && yarn test

* Then report:
    Output to stdout:
      "=============================================================="
      "PHASE {THE_PHASE_TO_BUILD} COMPLETE"
      "  routes built     : {n}"
      "  tests added      : {n}"
      "  cli verbs        : {n}"
      "  mcp tools        : {n}"
      "  canaries         : all green"
      "  next phase       : {next}"
      "=============================================================="


====================================================================
THE THINGS THAT GO WRONG, AND WHAT THEY LOOK LIKE
====================================================================

* /machine/v1/ping returns 200 with HTML instead of JSON.
  The plane was mounted AFTER the SPA catch-all in APP_MOUNT_FILE. Express matches in registration
  order. Move the mount up with the other app.use calls.

* /machine/v1/ping returns 404 with a valid key.
  The plane was never armed. initMachinePlane is called from run(), not at import, and if it
  returned null there is no key. Read the boot log.

* Every call returns 401 after a key change.
  The running server still holds the old key in memory. Restart it. This is deliberate; a plane
  that hot-reloads its own credential is a plane where a stolen key is revoked eventually.

* A test wrote a secret into the real home directory.
  Something resolved the key at import rather than at boot. Resolving MINTS. Set
  ABX_CREDENTIALS_FILE in the test and make sure the mint path is not on an import.

* yarn is not found after a node upgrade.
  Node 25 dropped bundled corepack. brew install corepack && brew link --overwrite corepack.

* just build dies with "CocoaPods is not installed."
  Something is trying to build mobile-client. The build recipe excludes it on purpose; use
  just build-mobile if the native app is actually wanted.

* A plan says one number and the apply does another.
  Something is predicting what the importer will do instead of asking it. Delete that code. plan
  and apply are one call with one boolean different.

* The model reports a total nobody computed.
  A total was missing from the analytics family, so it summed rows. Add the route. Do not add the
  instruction; the instruction is already in MCP_PROMPT_FILE and prose does not beat a missing tool.
