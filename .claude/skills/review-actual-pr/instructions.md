# review-actual-pr — Instructions

## At a glance

* **What it does:** runs a full review of one pull request in the upstream `actualbudget/actual` repo. That means a code review against the repo's own rules plus a functional test in a real browser.
* **What it carries out:** it fetches the PR's metadata and diff with `gh`, sorts the PR into bug, feature, or other, and reviews the diff in three tiers (Critical, Important, Suggestions). Then it drives `playwright-cli` against the live demo builds and takes screenshots.
* **Bug PRs:** it reproduces the bug on `https://edge.actualbudget.org/` first. Then it checks the fix on `https://deploy-preview-<num>.demo.actualbudget.org/` and gives a verdict from a truth table.
* **Feature PRs:** it tests on the Netlify preview only. It outlines the new UI with a red dashed box before each annotated screenshot, then takes one clean final shot.
* **Who runs it:** a developer or maintainer of Actual Budget who wants a PR vetted. Here, that is Bryan working in his fork, `~/BGit/Bryan_git/actual_budget_bryan`.
* **When it triggers:** whenever someone asks to review, test, validate, vet, QA, or "look at" an Actual PR. Examples: "review #1234", "does PR 1234 work", or a pasted `github.com/actualbudget/actual/pull/N` URL. It fires even when the word "review" is not used.
* **How to invoke:** `/review-actual-pr 7756`. The PR can also be given as `#7756`, `actualbudget/actual#7756`, or a full PR URL. The PR number is the only required input.
* **Where to run it:** from inside a clone of the Actual repo, such as `~/BGit/Bryan_git/actual_budget_bryan`. The highlight script is found with `git rev-parse --show-toplevel`. The GitHub repo is always hard-coded to `actualbudget/actual`, never your fork.
* **Where results go:** everything lands in `~/Downloads/pr-review-<num>/`. That folder holds `pr.json`, `diff.patch`, `review.md`, an optional `findings.json`, and the PNG screenshots. The same report is also printed to chat.
* **What it never touches:** it never posts to GitHub (no `gh pr comment`, no `gh pr review`, no comment API calls). It never pushes, never creates branches, and never modifies the repo's working tree.
* **Honesty rule:** it never fabricates a reproduction. If the demo budget cannot show the bug, or the PR does not say enough to build a repro, it stops the testing phase and says so.
* **Biggest gotcha:** `playwright-cli` must be on PATH. It is currently NOT on PATH on this Mac, so it falls back to `npx --no-install playwright-cli` and otherwise skips browser testing. Also, the Netlify preview may not have finished building yet.

## How it works

### Purpose

A thorough PR review needs three tedious jobs:

* reading the diff against the repo's many style and correctness rules
* finding and opening the right Netlify preview
* for bugs, proving the bug exists on the current edge build and is gone on the preview

This skill does all three in one pass. Its output is an offline report: every finding goes back to you in chat and in a saved markdown file, and nothing is ever written to the PR thread. You decide what to apply or post yourself.

The skill ships with upstream Actual. It was added in upstream PR #7967, "[AI] Add Claude Code skills for docs, commits, and PR review". It sits beside the sibling skills `committing-actual-changes`, `running-vrts`, `writing-actual-docs`, and `writing-release-notes` in `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/`.

### Inputs

The skill takes one input: the PR identifier.

* **Required:** a PR identifier in any of these forms: `7756`, `#7756`, `actualbudget/actual#7756`, or `https://github.com/actualbudget/actual/pull/7756`. It is reduced to the integer PR number.
* **Implicit:** the repo is always `actualbudget/actual`, and the output folder is `~/Downloads/pr-review-<num>/`. You can ask for a different output location, but all files from one run must stay together in one folder.
* **Mid-run choices it may ask you about:**
  * whether to continue if the PR is closed or merged
  * which class the PR belongs to if the bug and feature signals conflict or are weak
  * on a re-run at the same head SHA, whether to redo testing, redo the code review, or just reprint the old report
  * whether to browser-test an "other" PR (refactor, chore, docs, deps) anyway

### The typical run

1. **Resolve the PR number** from whatever form you gave.
2. **Fetch metadata and the diff.** It writes them to `pr.json` and `diff.patch`. If the PR is closed or merged, it asks whether to go on. If the PR is a draft, it notes that and proceeds.
3. **Check for an earlier run.** If `review.md` already exists, it compares that report's recorded head SHA with the PR's current head:
   * Same SHA: it asks what to redo.
   * Different SHA: it saves the old report as `review.<old-sha-short>.md` and diffs the old head against the new head, so the new report can say what changed.
4. **Classify the PR** as bug, feature/enhancement, or other. It uses labels, title prefixes (`fix:`, `feat:`, `[AI] fix`, …), `Fixes #` links, and the shape of the diff.
5. **Review the code.** It reads `references/code-review-rubric.md`, walks the diff, and writes Critical, Important, and Suggestions findings. Every finding has an exact `path:line`, a one- or two-sentence problem statement, and a pasteable fix. An empty tier is still printed, as "no Critical issues found".
6. **Test in the browser.** It follows the bug playbook or the feature playbook (described below). "Other" PRs skip this step by default.
7. **Write the report.** It saves `review.md` first, then prints it to chat.

### Run modes

* **Bug mode:** follows the playbook in `references/browser-testing-bug.md`.
  1. Open edge, click "Don't use a server", then "View demo".
  2. Reproduce the bug and screenshot it as `before-edge.png`.
  3. Open the preview, repeat the same steps, and screenshot the result as `after-preview.png`.
  4. Report whether the bug reproduces on edge (yes/no), whether it reproduces on the preview (yes/no), and a verdict.
* **Feature mode:** follows the playbook in `references/browser-testing-feature.md`.
  1. Open the preview only and resize the viewport to 1440×900.
  2. Walk the feature step by step. At each step, outline the new element with `highlight-element.js` and save `feature-step-N.png`.
  3. Remove the overlay before the next step.
  4. Finish with a clean `feature-final.png`.
* **Other mode:** code review only.

### Outputs

Every run writes to `~/Downloads/pr-review-<num>/`:

* `review.md`: the report. Its header must include `Head SHA` and `Reviewed` (an ISO 8601 timestamp), and it must end with the line saying no comments were posted to GitHub.
* `pr.json` and `diff.patch`: the raw inputs.
* `findings.json` (optional): the structured findings.
* PNG screenshots.
* `review.<sha>.md`: history files left by earlier runs.

### Worked example

You are in `~/BGit/Bryan_git/actual_budget_bryan` and type:

```
/review-actual-pr https://github.com/actualbudget/actual/pull/7756
```

Suppose PR 7756 is titled `[AI] fix: cash flow chart blank for last month`:

1. The skill classifies it as a bug and reviews the diff.
2. It opens edge, loads the demo, goes to Reports → Cash Flow → last month, sees the blank chart, and saves `before-edge.png`.
3. It opens `deploy-preview-7756.demo.actualbudget.org`, does the same, sees the chart render, and saves `after-preview.png`.
4. It reports "Verdict: fix confirmed".
5. Everything ends up in `~/Downloads/pr-review-7756/`.

## Full detail

### Allowed tools (from SKILL.md frontmatter)

`Bash(gh:*) Bash(playwright-cli:*) Bash(npx:*) Bash(mkdir:*) Bash(ls:*) Bash(git:*) Bash(cat:*) Bash(mv:*) Read Edit Write`. It may also use `AskUserQuestion` to settle the classification.

### Hard rules

1. It never runs `gh pr comment`, `gh pr review`, `gh api ... /comments`, or anything else that writes to the PR thread.
2. It never pushes commits, creates branches, or modifies the repo's working tree. Reading is allowed.
3. It never fabricates a reproduction. Partial evidence counts as worse than none.
4. Before touching GitHub, it checks `git config user.name` and `git config user.email`. If the identity is not the user's own (for example a bot or a shared account), it is extra careful that nothing can write to the PR.

### Stage 1: resolve input

It strips `#`, the `actualbudget/actual#` prefix, or the URL path, leaving the integer `<num>`. The repo is fixed at `actualbudget/actual`.

### Stage 2: fetch

```bash
mkdir -p ~/Downloads/pr-review-<num>
gh pr view <num> --repo actualbudget/actual \
  --json number,title,body,labels,state,isDraft,headRefName,headRepository,baseRefName,files,url,author,additions,deletions \
  > ~/Downloads/pr-review-<num>/pr.json
gh pr diff <num> --repo actualbudget/actual > ~/Downloads/pr-review-<num>/diff.patch
```

* **Closed or merged PR:** it tells you and asks whether to continue. The preview URL may still work for a while after a merge.
* **Draft PR:** it notes this and proceeds.

**Re-run logic.** If `~/Downloads/pr-review-<num>/review.md` exists, the skill reads it first. It then gets the current head with `gh pr view <num> --repo actualbudget/actual --json headRefOid -q .headRefOid` and compares it with the report's `Head SHA` line.

* **SHA matches:** it summarizes the prior report (nothing has changed) and asks whether to redo testing, redo the code review, or just reprint. It does no unrequested work.
* **SHA differs:** if needed it runs `git fetch origin pull/<num>/head`, then `git diff <old-sha> <new-sha>`, and moves the old report to `review.<old-sha-short>.md`.

Gotcha: in Bryan's fork, `origin` is `BryanStarbuck/actual_budget_bryan`, not upstream. `git fetch origin pull/<num>/head` therefore points at the fork's PR numbers. The SKILL.md does not address this case. You may need to fetch from an upstream remote instead.

### Stage 3: classify

Signals are checked in order of strength.

* **Bug:**
  * a label matching `bug`, `defect`, or `regression` (case-insensitive), or
  * a title starting with `fix:`, `bug:`, `hotfix:`, `[AI] fix`, or `[AI] bug`, or
  * `Fixes #` / `Closes #` in the body pointing to an issue with a `bug` label.
* **Feature/enhancement:**
  * a label `enhancement`, `feature`, `feature request`, or `improvement`, or
  * a title starting with `feat:`, `feature:`, `enhancement:`, `[AI] add`, or `[AI] feat`, or
  * a diff that adds substantial new components or pages.
* **Other** (refactor, chore, docs, deps): code review only. Browser testing is skipped unless the user insists.
* **Conflicting or weak signals:** it asks with `AskUserQuestion` and does not guess.

### Stage 4: code review

It reads `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/review-actual-pr/references/code-review-rubric.md`. That rubric is condensed from `~/BGit/Bryan_git/actual_budget_bryan/CODE_REVIEW_GUIDELINES.md`, `~/BGit/Bryan_git/actual_budget_bryan/AGENTS.md`, and `~/BGit/Bryan_git/actual_budget_bryan/.github/agents/pr-and-commit-rules.md`. Each finding cites the rule by its section name.

**Hard rejections:**

* new settings added for UI tweaks (propose a theme or design-token alternative instead)
* new `@ts-strict-ignore` (Important, or Critical if it hides a real type error)
* new `eslint-disable` or `oxlint-disable`
* secrets in code (always Critical)

**Types:**

* `type` over `interface`
* no `enum`; use object maps
* no `any` or `unknown` without justification; check `packages/loot-core/src/types/` for an existing type first
* `satisfies` over `as`, except in commented runtime type guards
* no `React.FC` or other `React.*` usage

**React:**

* React Compiler is on in `desktop-client`, so unnecessary `useCallback`, `useMemo`, or `React.memo` is a Suggestion
* `<Link>`, not `<a>`
* `useNavigate` comes from `src/hooks`
* `useDispatch`, `useSelector`, and `useStore` come from `src/redux`
* no nested component definitions

**Imports:**

* `import { v4 as uuidv4 } from 'uuid'`
* no direct color imports
* no `@actual-app/web/*` imports inside `loot-core`
* import group order: React → built-ins → external → actual packages → parent → sibling → index

**i18n:** every user-facing string is translated, with `<Trans>` preferred over `t()`.

**Financial typography:** standalone financial numbers use `FinancialText` or `styles.tnum`.

**Tests:**

* minimal mocks
* Vitest globals are fine
* E2E tests live in `packages/desktop-client/e2e/` and reuse the page models there

**Platform code:** no direct `.api` or `.electron` imports from non-platform code.

**AI-authored PR rules:**

* commits and the PR title are prefixed with `[AI]`
* the PR template is not filled in (unless a human explicitly asked, in which case it must be in Chinese)
* no `--no-verify`, no force-pushes to main

**Paths that get extra scrutiny:**

* `packages/loot-core/src/server/migrations/`: must be idempotent; Critical by default
* `packages/loot-core/src/server/budget/`: rounding and off-by-one errors
* `packages/desktop-client/src/components/budget/`
* `packages/sync-server/`: CRDT ordering and races
* `packages/desktop-client/e2e/*-snapshots/`: open each new PNG and check it matches the PR's intent

**Skipped:**

* `packages/component-library/src/icons/` (generated)
* `*/dist`, `*/build`, `*/lib-dist`
* machine-generated translations

**Finding format:** `path:line` taken from the diff hunks (not approximated), one or two sentences on the problem, and concrete replacement code or a diff snippet. Every tier heading appears even when the tier is empty.

### Stage 5a: bug browser test

Playbook file: `references/browser-testing-bug.md`.

1. **Derive a repro plan** from the PR title and body. If needed, fetch the linked issue with `gh issue view $ISSUE_NUM --repo actualbudget/actual --json title,body,labels`. If there is still no clear repro, stop testing and tell the user.
2. **Reproduce on edge.**
   * Run `playwright-cli open https://edge.actualbudget.org/`, then `playwright-cli snapshot`.
   * Load the demo: "Don't use a server" → "View demo".
   * Walk the repro plan, taking a snapshot after each step so element refs stay fresh.
   * Capture the failure with `playwright-cli screenshot --filename=$HOME/Downloads/pr-review-<num>/before-edge.png`.
   * If the bug does not reproduce, or the demo data lacks what the bug needs (for example multi-currency), report that and stop.
3. **Verify on the preview.**
   * Run `playwright-cli close`, then `playwright-cli open https://deploy-preview-<num>.demo.actualbudget.org/`.
   * If the page shows 404 or "site not found", wait about 10 seconds and reload once. If it still fails, stop testing and ship the code review without a testing section.
   * Repeat the setup and the repro, then save `after-preview.png`.
4. **Verdict** from this truth table (Edge / Preview):

   | Edge | Preview | Verdict |
   | --- | --- | --- |
   | yes | no | fix confirmed |
   | yes | yes | fix not observable (escalate) |
   | no | no | repro inconclusive |
   | no | yes | regression (also mark it Critical in the code review) |

   SKILL.md words the second verdict as "fix not visible" and the playbook as "fix not observable". They mean the same thing.
5. **Notes:**
   * For visual bugs, run `playwright-cli resize 1280 800` before each setup so both builds use the same viewport.
   * If the demo data is too small to show the bug, say so rather than reporting "looks fine".

### Stage 5b: feature browser test

Playbook file: `references/browser-testing-feature.md`.

1. **Write a plan:** what's new, where it lives in the UI, the 3 to 8 steps a user takes, and the end state that proves it works. If the PR description is too sparse for a clear plan, ask the user before testing.
2. **Set up:** open the preview only (never edge), load the demo, and run `playwright-cli resize 1440 900`.
3. **For each step:**
   1. Act, using refs from a snapshot.
   2. Find a stable selector for the new element: `data-testid` first, then role plus accessible name, then CSS. Avoid nth-child chains.
   3. Draw the highlight:
      ```bash
      SKILL_DIR="$(git rev-parse --show-toplevel)/.claude/skills/review-actual-pr"
      SELECTOR='...' LABEL='...' playwright-cli run-code --filename="$SKILL_DIR/references/highlight-element.js"
      ```
   4. Save `feature-step-N.png`.
   5. Remove the overlay with `playwright-cli eval "document.querySelectorAll('[data-pr-highlight]').forEach(n => n.remove())"`.
   6. If the layout changed (a modal opened, a panel slid out), re-snapshot before the next action.
4. **Final shot:** save a clean `feature-final.png` in the feature's end state.
5. **Verdict:** "Behavior matches PR description: yes / no / partially", one note per step, and any advertised behavior that is not visible in the build.
6. **If highlighting fails:** try a coarser parent selector. As a last resort, take the shot without the annotation and flag the gap in the report. It never silently produces un-annotated shots.
7. **Avoid:** clearing localStorage mid-run (it forces redoing the demo setup), and screenshotting before animations finish.

**Fresh state, when truly needed:** `playwright-cli localstorage-clear`, then `playwright-cli reload`.

### highlight-element.js

Location: `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/review-actual-pr/references/highlight-element.js`.

It is a CommonJS module exporting `async page => {...}`. It reads the `SELECTOR` env var (required; it throws if missing) and the `LABEL` env var (optional). It then:

1. scrolls the element into the center of the viewport
2. draws a fixed-position red (#e3342f) 3px dashed box with 6px padding
3. adds an optional red label pill above the box
4. tags both overlay nodes with `data-pr-highlight`
5. throws `Highlight failed: not-found|zero-size` if the element is missing or has no size
6. waits 50 ms so the overlay paints before the screenshot

### Stage 6: report format

```
# PR #<num>: <title>
**Author:** … · **Classification:** bug|feature|other · **Diff:** +a / −d
**Head SHA:** <full sha> · **Reviewed:** <ISO 8601>
## Code review  (### Critical / ### Important / ### Suggestions)
## Testing  (narrative, **Screenshots:** list with captions, **Verdict:**)
---
_No comments were posted to GitHub. All suggestions above are local recommendations._
```

The report is saved to `~/Downloads/pr-review-<num>/review.md` with `cat > ... <<'EOF'` BEFORE it is printed to chat. The `findings.json` file is optional, and its schema is not specified.

Final folder layout:

* `pr.json`
* `diff.patch`
* `review.md`
* `findings.json` (optional)
* `before-edge.png` and `after-preview.png` (bug PRs)
* `feature-step-N.png` and `feature-final.png` (feature PRs)
* `review.<sha>.md` (history from earlier runs)

### Backups and incremental behavior

The only "backup" is renaming an earlier `review.md` to `review.<old-sha-short>.md` when the PR head has moved. There is no other backup scheme. Screenshots with the same names are overwritten on a re-run.

### Dependencies

* **`gh` CLI**, authenticated with read access to `actualbudget/actual`. It is present at `/opt/homebrew/bin/gh`.
* **`playwright-cli`**, usually installed through a `playwright-cli` skill. It is NOT currently on PATH on this machine. The fallback is `npx --no-install playwright-cli`. If that also fails, the skill reports the problem and skips browser testing. It never swaps in another tool, such as the Chrome MCP.
* **Network access** to `edge.actualbudget.org` and `deploy-preview-<num>.demo.actualbudget.org`.
* **No API keys or MCP servers** are needed.

### Failure modes

* The preview is not yet built, or returns 404/502: one retry, then testing is skipped.
* The demo lacks the data the bug needs: testing stops and the gap is reported.
* The repro is unclear even after reading the linked issue: testing stops.
* `playwright-cli` is missing: testing is skipped.
* The classification is ambiguous: the skill asks you.
* Re-run fetches go through a fork `origin`: see the gotcha in Stage 2.

### Related

* **Sibling skills** in `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/`:
  * `committing-actual-changes`
  * `running-vrts`, for the VRT snapshots this skill inspects
  * `writing-actual-docs`
  * `writing-release-notes`
* **Source rule files:**
  * `~/BGit/Bryan_git/actual_budget_bryan/CODE_REVIEW_GUIDELINES.md`
  * `~/BGit/Bryan_git/actual_budget_bryan/AGENTS.md` (its "Testing and previewing the app" section defines the demo setup)
  * `~/BGit/Bryan_git/actual_budget_bryan/.github/agents/pr-and-commit-rules.md`
