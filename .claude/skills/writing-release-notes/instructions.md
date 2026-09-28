# writing-release-notes — Instructions

## At a glance

* **What it accomplishes:** writes the one-line, user-facing changelog entry that must ship with every code change in the Actual Budget repo (the upstream `actualbudget/actual` codebase, forked here as `~/BGit/Bryan_git/actual_budget_bryan/`).
* **What it actually carries out:** creates exactly one Markdown file, `upcoming-release-notes/<slug>.md`, holding YAML front matter (`category`, `authors`) and a single sentence of body text.
* **Who runs it:** a developer (human or Claude Code) who has just finished a change in this repo and is preparing the pull request.
* **When and why:** at the end of a user-facing change, or whenever someone asks to "add a release note", "write the changelog entry", or fix an existing note. CI fails a PR that adds no release note.
* **How to invoke:** it is a model-triggered skill (no arguments). Say something like `/writing-release-notes` or "add the release note for this change"; Claude reads SKILL.md and writes the file.
* **Required inputs:** what changed (from the diff or your description), which of the four categories it falls in, and the GitHub username(s) of the authors.
* **Optional inputs:** a preferred slug/filename and a PR title to mirror; otherwise Claude picks a short kebab-case slug and words the sentence itself.
* **Where to run it:** anywhere inside the repo; the file always goes in the repo-root directory `~/BGit/Bryan_git/actual_budget_bryan/upcoming-release-notes/`.
* **Where results land:** `~/BGit/Bryan_git/actual_budget_bryan/upcoming-release-notes/<slug>.md` (for example `add-payee-autocomplete.md`). Nothing else is written.
* **What it will not touch:** source code, the published docs, the `README.md` in that folder, or other contributors' notes; it does not use a PR number as the filename.
* **Writing rules:** one sentence, plain language, imperative present tense ("Add …", "Fix …", "Show …"), no file/function/component names; only `Maintenance` entries may be technical.
* **Biggest gotcha:** SKILL.md lists the bug category as `Bugfix`, but the canonical value used by the tooling is `Bugfixes`. Both pass CI (`Bugfix` is auto-corrected), but the body must be exactly one line or the CI check rejects it.

## How it works

### Purpose

Actual Budget publishes a changelog for everyday users at each release. Rather than editing one shared changelog (which causes merge conflicts), every change adds its own small Markdown file to `upcoming-release-notes/`. At release time a script collects those files, groups them by category, resolves each file's PR link from git history, and builds the published notes. This skill exists so Claude writes those files correctly the first time: short, non-technical, correctly categorized. The skill's own description warns that notes written like commit messages, with implementation jargon, get flagged and rewritten in review.

The authoritative rules live in the "Writing Good Release Notes" section of `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/contributing/index.md`. The skill is a condensed version of that section. If anything in the skill is unclear, read that section.

### The typical run

1. You finish a code change in the repo (a feature, an improvement, a bug fix, or internal maintenance).
2. You ask Claude for the release note, or Claude reaches that step itself while wrapping up.
3. Claude decides the category, finds the author username(s), picks a slug, and writes one sentence describing the change from the user's point of view.
4. Claude creates `upcoming-release-notes/<slug>.md`. You commit it with the change.

### The inputs and what each one controls

| Input | What it does | Where it comes from |
|---|---|---|
| Category | Which heading the entry appears under in the changelog | Chosen from the four allowed values (below) |
| Authors | Credited GitHub usernames (`@name` in the changelog) | The person or people who did the work; an array, even for one person |
| Slug | The filename | A short kebab-case description of the change (`fix-mobile-category-delete`) |
| Body sentence | The changelog line itself | The change, reworded for a user; usually close to the PR title |

Allowed categories:

* `Features` — a new feature.
* `Enhancements` — an improvement to an existing feature.
* `Bugfixes` (SKILL.md writes `Bugfix`; both are accepted) — a bug fix.
* `Maintenance` — an internal change users will not see. Only this category may use technical wording.

### Run modes

There is only one mode: create (or fix) a single release-note file. The skill also triggers when an existing note needs correcting, in which case Claude edits that note in place under the same rules. There is no batch mode, no flags, and no scripts bundled with the skill.

### Output

One file:

```markdown
---
category: Features
authors: [YourGitHubUsername]
---

Add payee autocomplete to the transaction entry form
```

Location: `~/BGit/Bryan_git/actual_budget_bryan/upcoming-release-notes/<slug>.md`.

### Worked example

Request: "I fixed the reconcile balance being wrong when there are future-dated transactions. Add the release note. My GitHub is BryanStarbuck."

Result: `upcoming-release-notes/fix-reconcile-future-transactions.md`

```markdown
---
category: Bugfixes
authors: [BryanStarbuck]
---

Fix incorrect balance when reconciling an account with future transactions
```

The skill's own contrast example of what not to write: `Fix off-by-one in reconcileTransactions() when txn.date > today`, which is too technical.

### Manual alternative

The repo has an interactive generator, `yarn generate:release-notes` (runs `~/BGit/Bryan_git/actual_budget_bryan/bin/release-note-generator.mts`). It asks for usernames, a slug (auto-filled from the branch name or PR title), the type, and a summary. The skill does not run it; it writes the file directly. The generator works better with the GitHub CLI installed and `gh auth login` done.

## Full detail

### Files in the skill directory

* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/writing-release-notes/SKILL.md` — the whole skill (front matter `name`, `description`, plus the rules). No supporting references, templates, or scripts exist in the directory.
* Sibling skills in the same repo: `committing-actual-changes`, `review-actual-pr`, `running-vrts`, `writing-actual-docs` (all under `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/`).

### Steps, in order

1. Identify the change being described (from the working diff, the PR, or the user's words).
2. Choose exactly one category: Features, Enhancements, Bugfix(es), or Maintenance.
3. Determine the author GitHub username(s).
4. Choose a short, descriptive kebab-case slug. Do not use the PR number. (Numeric names such as `1234.md` still work but a slug is preferred.)
5. Write the body: one sentence, imperative present tense, plain language, no internal names; technical wording only if the category is Maintenance. Match the PR title unless rewording is clearer.
6. Write `upcoming-release-notes/<slug>.md` with the front matter and body.

### Input files it reads (for reference)

* `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/contributing/index.md` — "Writing Good Release Notes" section (authoritative, read if unclear).
* `~/BGit/Bryan_git/actual_budget_bryan/AGENTS.md` — the Documentation section repeats the slug-naming rule and points to the same docs page.
* Existing notes in `~/BGit/Bryan_git/actual_budget_bryan/upcoming-release-notes/` serve as examples (about 57 files at the time of writing, a mix of slug and numeric names).

### Output file format

* Path: `~/BGit/Bryan_git/actual_budget_bryan/upcoming-release-notes/<slug>.md`.
* YAML front matter delimited by `---`:
  * `category`: string, one of the allowed values.
  * `authors`: YAML array of GitHub usernames, e.g. `[user1, user2]`.
* Body: exactly one non-empty line after trimming.

### How the tooling validates and uses the file

These are not part of the skill but explain why its rules matter:

* CI check: `~/BGit/Bryan_git/actual_budget_bryan/packages/ci-actions/bin/release-notes-check.mjs`. It looks for `.md` files ADDED under `upcoming-release-notes/` relative to `origin/$BASE_REF` (excluding `README.md`). It fails if none were added, if `category` is missing or not allowed, if `authors` is missing or not an array, or if the trimmed body is empty or contains a newline.
* Category list and auto-corrections: `~/BGit/Bryan_git/actual_budget_bryan/packages/ci-actions/src/release-notes/util.mjs`. Canonical order is `Features`, `Enhancements`, `Bugfixes`, `Maintenance`; `Feature`, `Enhancement`, and `Bugfix` are auto-corrected to the plural forms.
* Release generation: `~/BGit/Bryan_git/actual_budget_bryan/packages/ci-actions/bin/release-notes-generate.mjs` collects the notes, formats authors as `@name`, and resolves each file's PR number from git history, which is why the filename need not contain it. `.github/workflows/cut-release-branch.yml` and `.github/scripts/count-points.mjs` also reference the directory.
* Interactive generator: `~/BGit/Bryan_git/actual_budget_bryan/bin/release-note-generator.mts` (script `generate:release-notes` in the root `package.json`); it writes `Bugfixes` as the value for bug fixes.

### Concurrency and agents

None. The skill is a single, short, inline task. It spawns no agents and runs no scripts.

### Re-run and incremental behavior

Not specified by the skill. Each change gets its own new file; re-running for the same change should edit that change's existing note rather than create a second one (a reasonable reading, not stated explicitly). It keeps no state, run log, or last-run record.

### Backups

None. The output is a small git-tracked file.

### Safety rules

* Write only the one note file; do not edit other contributors' notes or `upcoming-release-notes/README.md`.
* Keep technical detail out of non-Maintenance notes.
* No PR number in the filename.

### Failure modes

* Multi-line body or bullet list: the CI check rejects it.
* `authors` written as a plain string instead of an array: rejected.
* Invalid category spelling (anything besides the four plus the three auto-corrected singulars): rejected.
* Past-tense or third-person phrasing ("Added", "Adds"): passes CI but violates the style rule and is likely to be flagged in review.
* Implementation jargon in a user-facing note: passes CI but is flagged and rewritten in review.
* Noted inconsistency: SKILL.md says `Bugfix`, while the docs generator and canonical list use `Bugfixes`. Both are valid; existing notes use `Bugfixes`.

### Dependencies

None for the skill itself: no MCP servers, CLIs, or API keys. The optional manual generator benefits from the GitHub CLI (`gh`) being logged in. The CI check needs `BASE_REF` and runs in GitHub Actions.

### Related skills and prompts

* `committing-actual-changes` — committing work in this repo (the note is committed alongside the change).
* `review-actual-pr` — PR review, where poorly written notes get flagged.
* `writing-actual-docs` — writing the separate user documentation in `packages/docs/`.
