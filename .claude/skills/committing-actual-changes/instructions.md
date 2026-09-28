# committing-actual-changes — Instructions

## At a glance

* **What it does:** a short guard-rail skill that makes sure every git commit and pull request an AI agent creates in the Actual Budget repo follows the repo's AI-contribution rules.
* **What it carries out:** nothing by itself. It tells the agent to read `~/BGit/Bryan_git/actual_budget_bryan/.github/agents/pr-and-commit-rules.md` fresh at the start of every commit/PR session, then apply those rules.
* **The one rule it restates:** every commit message and every PR title MUST start with `[AI]`, for example `[AI] Fix type error in account validation`.
* **Who runs it:** Claude Code (or another agent) working in this repo on behalf of a developer (Bryan). It is model-invoked. A human does not normally type it.
* **When it fires:** whenever the agent is about to commit, amend, push, or open a PR in this repo ("commit this", "open a PR", "ship it", "push these changes"). It also fires when someone mentions `[AI]`, the PR template, git hooks, or `--no-verify`.
* **How to invoke:** it is triggered automatically by its description. You can also name it explicitly: `/committing-actual-changes`. It takes no arguments. The run text is simply the commit or PR request.
* **Inputs:** no parameters. The inputs it reads are the rules file above, `~/BGit/Bryan_git/actual_budget_bryan/.github/PULL_REQUEST_TEMPLATE.md`, and the staged changes being committed.
* **Where it runs:** from inside the repo `~/BGit/Bryan_git/actual_budget_bryan/`. Claude Code only loads the skill in that project, from `.claude/skills/`.
* **Where results land:** it writes no files. The results are a git commit in the local repo and/or a GitHub pull request whose body is the blank PR template, unmodified.
* **What it will not do:** fill in the PR template (unless a human explicitly asks, and then only in Simplified Chinese), create GitHub issues, skip hooks (`--no-verify`), change git config, force-push, or push to main/master.
* **Enforcement:** `scripts/agent-hooks/git-guard.sh` blocks a commit message without the `[AI]` prefix. `pr-template-blank.sh` blocks a filled-in PR body. **Nothing checks the PR title**, so that is the one the agent has to remember.
* **Biggest gotcha:** the skill deliberately does not copy the rules. It points at the rules file because that file changes over time. If you skip reading it, you miss newer rules, such as the 🤖 prefix on every GitHub comment and review. Separately, Bryan's own rules (never create or push branches, never commit private financial data) still apply on top of the repo's rules.

## How it works

### Purpose

This repository, `~/BGit/Bryan_git/actual_budget_bryan/`, is Bryan's fork of the open-source Actual Budget app (upstream `actualbudget/actual`; origin `https://github.com/BryanStarbuck/actual_budget_bryan.git`). Upstream has strict, unusual rules for contributions written by AI. Maintainers triage AI-authored work separately. The `[AI]` prefix makes that triage fast, and a GitHub workflow (`.github/workflows/ai-generated-label.yml`) uses the `[AI]` title prefix to add an "AI generated" label automatically. If the prefix is missing, the PR looks like a human contribution and gets the wrong review process.

The PR-template rule exists for a similar reason. The human who actually tested the change is the one who should write the Description, Testing, and Checklist sections honestly. A template filled in by an AI misrepresents who did what.

### The typical run

1. The developer finishes a change and says something like "commit this" or "open a PR".
2. The skill loads and tells the agent to read `.github/agents/pr-and-commit-rules.md` now. It says to do this on every commit/PR session and not to rely on the summary inside the skill.
3. The agent applies the rules:
   * Commit subject starts with `[AI]`.
   * PR title starts with `[AI]`.
   * PR body is the exact contents of `.github/PULL_REQUEST_TEMPLATE.md`: placeholders intact, all checkboxes unchecked.
   * Anything the agent posts to GitHub (comments, reviews, edited issue titles and bodies) starts with 🤖.
   * No GitHub issues are created. The agent proposes the title and body to the user instead.
4. The commit runs through the normal Husky pre-commit hook (`yarn nano-staged`: oxfmt and oxlint on staged files). The hook is never skipped.

### Input parameters

The skill takes no parameters. What it acts on:
* **The request wording.** "Commit" and "PR" decide which rules matter most.
* **An explicit human request to fill in the PR template.** This is the only exception to the blank-template rule. If a human asks for it, the agent fills the template in Simplified Chinese (简体中文).

### Run modes

There are no formal modes. In practice it covers three cases:
* **Commit only:** the `[AI]` subject prefix is enforced by the hook.
* **PR creation:** `[AI]` title (nothing enforces this) and a blank template body (enforced by a hook on `mcp__github__create_pull_request`).
* **GitHub commenting and reviewing:** the 🤖 prefix, enforced by `github-comment-style.sh`.

### Outputs

The skill writes no files. The outputs are the git commit (local repo history) and the pull request on GitHub.

### Worked example

The user says "commit and open a PR for the payee-rule fix". The agent then:
* reads the rules file
* stages the change and checks the staged diff for private financial data (Bryan's CLAUDE.md rule for this repo)
* runs `git commit -m "[AI] Fix payee rule matching for split transactions"`
* opens a PR titled `[AI] Fix payee rule matching for split transactions`, with the body set to the verbatim `.github/PULL_REQUEST_TEMPLATE.md`

A commit written as `git commit -m "Fix payee rule"` would be blocked by git-guard.sh with: `Blocked: commit messages must start with '[AI]'. Got: Fix payee rule`.

## Full detail

### Files in the skill directory

* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/committing-actual-changes/SKILL.md`: the only definition file, about 2.8 KB. There are no references, scripts, or templates.
* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/committing-actual-changes/instructions.md`: this manual.

### Steps, in order

1. Trigger on commit/PR intent (see the phrases in the SKILL.md description).
2. Read `~/BGit/Bryan_git/actual_budget_bryan/.github/agents/pr-and-commit-rules.md` in full, every session.
3. Prefix the commit subject with `[AI]`.
4. Prefix the PR title with `[AI]`.
5. Use the blank PR template as the PR body.
6. Prefix any GitHub comment, review, or issue edit with 🤖.
7. Never create GitHub issues.

### What the rules file currently says (as of 2026-09-23; always re-read it)

* **PR titles:** all must be prefixed `[AI]`.
* **PR template:** never fill in `.github/PULL_REQUEST_TEMPLATE.md`. Use it unmodified as the body: blank spaces, placeholder comments, and unchecked boxes all left as they are. Exception: if a human explicitly asks, fill it in Simplified Chinese.
* **No GitHub issues:** agents must never create issues, either through `issue_write` with method `create` or through `gh issue create`. Updating and commenting on existing issues is allowed.
* **🤖 prefix:** every PR/issue comment, PR review (including inline comments), and edited issue title and body starts with 🤖. This does not change the `[AI]` rule for PR titles and commit messages.

`~/BGit/Bryan_git/actual_budget_bryan/CLAUDE.md` imports both `@AGENTS.md` and `@.github/agents/pr-and-commit-rules.md`, so the rules are usually already in context. `AGENTS.md` also says: run `yarn typecheck` before committing (under "Quick Start Commands"), and follow the "Code Quality Checklist".

### Enforcement hooks

These are wired in `~/BGit/Bryan_git/actual_budget_bryan/.claude/settings.json`. The same scripts are wired for Codex (`.codex/hooks.json`) and Cursor (`.cursor/hooks/`).

* `scripts/agent-hooks/git-guard.sh` (PreToolUse on Bash). It is best-effort and fails closed on a malformed payload. It blocks:
  * `--no-verify` and `--no-gpg-sign`
  * any `git config` write (reads with `--get`, `--list`, or `-l` are allowed)
  * `git push` with `--force` or `-f`
  * a push to main or master (including `refs/heads/...` refspecs)
  * a `git commit` whose first `-m`/`--message` subject does not start with `[AI]`. It parses inline strings and `$(cat <<'EOF' …)` heredocs.
  * `gh … issue create`
  * yarn run inside a `packages/` child workspace

  Per its own comments, it does not catch `git commit -F`, `-C`, `--amend` with an editor, or global options placed before the subcommand. CI and branch protection are the real gates.
* `scripts/agent-hooks/pr-template-blank.sh` (PreToolUse on `mcp__github__create_pull_request`). It compares `.tool_input.body` to the template, ignoring only CR/LF, trailing whitespace, and leading or trailing blank lines. It fails open if the template or body is missing.
* `scripts/agent-hooks/no-issue-create.sh` (on `mcp__github__issue_write`). Only `method: update` is allowed.
* `scripts/agent-hooks/github-comment-style.sh`. Requires 🤖 on the body and title of comments, reviews, and issue writes.
* Dependency: all hooks need `jq` (`scripts/agent-hooks/common.sh` `require_jq`). They block with an actionable message if it is missing.
* Git hooks (Husky): `.husky/pre-commit` runs `yarn nano-staged`, configured in `.nano-staged.json`:
  * oxfmt on js, ts, md, json, and yml files
  * `oxlint --fix --type-aware` on js and ts files
  * publish-import validation and tsconfig sync on `packages/*` package.json and tsconfig changes

  `.husky/post-checkout` and `.husky/post-merge` re-run `yarn install` when `yarn.lock` changes.

### PR template

The template is `~/BGit/Bryan_git/actual_budget_bryan/.github/PULL_REQUEST_TEMPLATE.md`. It has these sections: Description, Related issue(s), Testing, and Checklist (release notes added, no obvious regressions, self-review). It ends with the `<!--- actual-bot-sections --->` marker. It must go in verbatim.

### Re-run behavior, concurrency, backups

The skill has no state, no agents, no backups, and no incremental logic. It is read-and-apply every time.

### Local rules that stack on top (from Bryan's CLAUDE.md files, not from the skill)

* **Private data:** `~/BGit/Bryan_git/actual_budget_bryan/` is going open source. Before committing, check the staged diff for any real financial data (account numbers, balances, payees, statement text) from `~/BGit/Bryan_git/Bryan_Arindom/bank_statements/`. If anything looks real, stop and ask Bryan.
* **Branches:** Bryan's global rules say never to create, switch, or push branches unless he explicitly asks. The upstream rules assume feature-branch PRs. When the two conflict, follow Bryan's instruction and ask.
* Memory note: an auto-commit job on Bryan's machine may commit and push working-tree changes on its own. That job does not go through this skill.

### Failure modes

* **Forgotten `[AI]` on the PR title:** nothing blocks it, so the PR has to be renamed by hand. It also loses the automatic "AI generated" label, because that label only fires on the `opened`, `reopened`, and `edited` events.
* **Filled-in template:** blocked by the hook.
* **Commit prefix missed through an evasive form** (`-F`, editor): not caught locally.
* **Missing `jq`:** every guarded call is blocked.

### Related

* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/writing-release-notes/SKILL.md`: release notes go in `upcoming-release-notes/`. The PR checklist asks for them.
* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/review-actual-pr/`: reviewing PRs, with the 🤖 comment rule.
* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/running-vrts/` and `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/writing-actual-docs/`: sibling repo skills.
* `~/BGit/Bryan_git/actual_budget_bryan/.cursor/rules/pr-and-commit.mdc`: the Cursor equivalent of this skill.
* `~/BGit/Bryan_git/actual_budget_bryan/.github/workflows/ai-generated-label.yml`: adds the label.
* The generic `/commit` skill elsewhere on the machine does not know these rules. In this repo, this skill's rules win.
