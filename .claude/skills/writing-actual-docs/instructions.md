# writing-actual-docs — Instructions

## At a glance

* **What it accomplishes:** makes sure any documentation you write or edit for the Actual Budget docs site (`packages/docs/`, published at actualbudget.org/docs) follows the project's own style guide, so it passes the build, the spell-check, and maintainer review on the first try.
* **What it actually carries out:** it is a guidance skill, not a generator or a script. It tells Claude to read `packages/docs/docs/contributing/writing-docs.md` in full first, write the doc, then check the result against a short structural checklist.
* **Who runs it:** anyone editing Actual Budget docs with Claude Code: a contributor, a maintainer, or Bryan working in his fork `~/BGit/Bryan_git/actual_budget_bryan`. Usually Claude loads it by itself; nobody has to name it.
* **When and why:** whenever a task creates, updates, restructures, or fixes any `.md` / `.mdx` file under `packages/docs/`. Typical requests: "add a doc page for X", "update the FAQ", "document this setting", "fix the docs about Y". Docs written without the guide tend to fail review.
* **How to invoke:** it is model-triggered by its description. You can also name it: `/writing-actual-docs` followed by the docs task, e.g. `/writing-actual-docs add a page documenting the new CSV import option`.
* **Inputs:** required: the docs task in plain language (what page, what feature, what to fix). Optional: the feature or code to document, and screenshots to add. It has no flags or parameters.
* **Where to run it:** from inside the Actual Budget monorepo, `~/BGit/Bryan_git/actual_budget_bryan/` or any subdirectory. The skill lives in that repo's `.claude/skills/` and only makes sense there.
* **Where results land:** the doc files you asked for under `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/<section>/`, images under `packages/docs/static/img/<section>/`, and, only if needed, an allowlist entry in `.github/actions/docs-spelling/typos.toml`. It writes no report or log of its own.
* **Authority:** `packages/docs/docs/contributing/writing-docs.md` is the source of truth. The skill deliberately does not repeat its rules, so the guide wins over anything in SKILL.md or in this manual.
* **Structural checklist before done:** exactly one H1 (or a front-matter `title` and no H1), Title Case headings (Chicago rules), no time-bound phrasing, internal links as relative file paths with `.md` (not `/docs/...` URLs), and images at the correct path.
* **What it will not touch:** it does not edit app code, does not add spelling allowlist entries for words that are really misspelled, and does not invent new patterns when an existing doc in the same section already shows the convention.
* **Biggest gotcha:** broken internal links or anchors **fail the build**. `docusaurus.config.js` sets `onBrokenLinks`, `onBrokenAnchors`, and `onBrokenMarkdownLinks` to `'throw'`. One `/docs/...`-style link or a mistyped `#anchor` breaks `yarn build:docs`.

## How it works

### Purpose

Actual Budget's documentation is a Docusaurus site inside the monorepo at `packages/docs/`. Most readers are end users, not developers, so the project deliberately prefers verbose, step-by-step explanations. The site also has strict mechanical rules: heading levels, front matter, link format, image placement and naming, admonition syntax, and a spell-checker in CI. This skill makes Claude read the contributor style guide before writing, instead of guessing at those rules.

SKILL.md is short on purpose. It says there is "no point restating" the style guide "because it will go stale faster than the source." The skill is a pointer to the guide plus a four-step routine.

### The typical run

1. You ask for a docs change, e.g. "write a guide for the new bulk-edit feature."
2. Claude matches the skill's description and loads it, or you invoke `/writing-actual-docs` yourself.
3. Claude reads `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/contributing/writing-docs.md` in full (about 424 lines).
4. Claude drafts or edits the doc. Where the guide says nothing, it copies the pattern of the closest existing doc in the same section.
5. For new screenshots, Claude follows the path and naming rules (`/static/img/<section>/<doc-prefix>-...png`) and the annotation guidance. Any screenshot showing more than one element the reader needs to tell apart gets annotated.
6. Before saying it is done, Claude checks the file against the structural checklist (see At a glance). If the `typos` spell-checker flags a word that is actually correct, Claude adds it to `.github/actions/docs-spelling/typos.toml`.

### Inputs

There are no parameters or modes. The only input is your request, and it can include:
* **The target:** an existing page (`docs/faq.md`) or a new page and its section (`budgeting`, `accounts`, `install`, and so on).
* **The subject:** the feature, setting, or behavior to document. Claude may read the app code to describe it accurately.
* **Screenshots:** images to place and reference. Per the guide they must be PNG, taken in light mode, and capture at most about 1100×700 px of screen.

### Outputs

* New or edited Markdown files under `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/`.
* Image files under `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/static/img/<section>/`, or `static/img/elements/<element>/` for images reused across pages.
* Occasionally one line in `~/BGit/Bryan_git/actual_budget_bryan/.github/actions/docs-spelling/typos.toml`, under `[default.extend-words]`, mapping a word to itself (e.g. `HSA = "HSA"`).

### Worked example

Request: `/writing-actual-docs add a page to the budgeting section explaining category notes, with one screenshot`

What Claude should do:
* Read `writing-docs.md`, then look at pages in `packages/docs/docs/budgeting/` to match their tone and layout.
* Create `packages/docs/docs/budgeting/category-notes.md` with one `# Category Notes` H1, `##` sections in Title Case, and numbered steps in present tense ("Click the note icon…", not "As of the June release you can…").
* Save the screenshot as `packages/docs/static/img/budgeting/category-notes-editor.png` and reference it as `/img/budgeting/category-notes-editor.png` with alt text.
* Link to another page with a relative file path, e.g. `[Categories](./categories.md)`.
* Check the checklist. If the page needs to appear in the sidebar, compare with `packages/docs/docs-sidebar.js`; the skill does not say anything about this, so follow the existing entries.

## Full detail

### Files in the skill directory

* `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/writing-actual-docs/SKILL.md`: the whole skill, about 2.9 KB. Front matter `name: writing-actual-docs` and a long trigger `description`. No supporting files, scripts, templates, or appendices.
* `instructions.md`: this manual.

The skill came in with upstream commit `64f230833` "[AI] Add Claude Code skills for docs, commits, and PR review (#7967)". The repo is Bryan's fork (`origin` = `https://github.com/BryanStarbuck/actual_budget_bryan.git`) of `actualbudget/actual`.

### The four steps, as SKILL.md states them

1. **Read `writing-docs.md` in full before drafting.**
2. **Fill gaps from neighbors.** When the guide does not cover something, match the closest existing document in the same section. The skill says "site-wide consistency matters more than a marginally better local choice."
3. **Screenshots.** Place them at `/static/img/<section>/<doc-prefix>-...png` and follow the guide's annotation rules. Annotate any screenshot that shows more than one element the reader must distinguish.
4. **Sanity check before declaring done:**
   * exactly one H1
   * Title Case headings
   * no time-bound phrasing
   * internal links as relative file paths with the `.md` extension, not `/docs/...` URLs
   * images referenced from the correct path
   * spelling allowlist in `.github/actions/docs-spelling/typos.toml` only if `typos` flags a term that is actually correct

### Input file it reads (the authority)

`~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/contributing/writing-docs.md`. Its main rules, summarized here for orientation only (the file itself wins):

* **Audience:** mostly end users. Be verbose and spell out every step.
* **Front matter:** optional (`title:` and other metadata). If `title` is set, omit the H1; if not, start with an H1. Only one level-1 heading per document.
* **Headings:** H2 for main sections, H3 for subsections, H4 if needed. H1 and H2 show in the right sidebar. All headings in Title Case (Chicago Manual of Style).
* **Folder structure:** follows the left sidebar. Sections with more than one page get a directory (`accounts`, `advanced`, `backup-restore`, `budgeting`, `contributing`, `experimental`, `getting-started`, `install`, `migration`, `reports`, `tour`, `transactions`, `troubleshooting`, …).
* **Tone:** friendly, active voice, time neutral (present tense; time references only for experimental or unreleased features, removed on release).
* **Style:** `$` prefix on money, comma thousands separator, no `$` or separators inside calculations. Short paragraphs, lists, and the product called "Actual Budget" or "Actual".
* **Links:** relative file paths with `.md`, anchors after the extension (`../api/reference.md#importtransactions`). Blog posts and `src/pages/` use relative URLs instead (e.g. `../../docs/install/`).
* **Blog posts in the app:** `in_app_notification: true` in front matter puts a non-release post in the in-app Notifications page. The feed is generated into `packages/desktop-client/src/data/news.json` (CI regenerates it; locally `yarn generate:news-feed`).
* **Components:** `<Key k="enter" />`, `<Key mod="shift" k="enter" />`, and so on; admonitions `:::tip`, `:::note`, `:::caution`, `:::warning` (warning is for things that can mess up a budget); `<details><summary>…</summary>…</details>` for collapsible content.
* **Spelling:** CI runs `typos` (crate-ci). Fix real misspellings; add false positives to `[default.extend-words]` in `/.github/actions/docs-spelling/typos.toml` mapped to themselves.
* **Naming:** descriptive filenames that match the title; folder names match the sidebar.
* **Images:** in `/static/img/<section>/`, prefixed with the doc name (`categories-…` for `categories.md`). Shared images go in `/static/img/elements/<element>/`. PNG only, light mode, at most about 1100×700 px of screen captured, alt text strongly encouraged, retina shots named `name@2x.png`.
* **Annotation:** boxes rather than arrows; numbered steps for a sequence, letters for separate elements (or differently colored boxes); no free-hand marks; no transparency or spotlight effects; suggested colors Red FF594B, Yellow FBBA00, Purple 77409A, Blue 70AFFD, Green 00BBA1; never red and green on the same image; no pure white or black.

### Other files it touches or relies on

* `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs/**`: the docs being written (read neighbors, write targets).
* `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/static/img/**`: screenshot destinations.
* `~/BGit/Bryan_git/actual_budget_bryan/.github/actions/docs-spelling/typos.toml`: spelling allowlist. Its `[files] extend-exclude` already skips `releases.md`, `*-release-*.md`, images, and lockfiles.
* `~/BGit/Bryan_git/actual_budget_bryan/.github/workflows/docs-spelling.yml`: the CI workflow that runs `typos` (not named in the skill, but it is what enforces spelling).
* `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docusaurus.config.js`: sets `onBrokenLinks`, `onBrokenAnchors`, and `onBrokenMarkdownLinks` to `'throw'`.
* `~/BGit/Bryan_git/actual_budget_bryan/packages/docs/docs-sidebar.js`: sidebar definition. The skill does not mention it; a brand-new page may need an entry here to show in the sidebar.

### Verifying the result (not required by the skill, but available)

* `yarn build:docs` from the repo root (runs `yarn workspace docs build`, which regenerates upcoming release notes and then `docusaurus build`). Broken links or anchors fail here.
* `yarn start:docs` for a local preview.
* The skill does not tell Claude to run either one. It only asks for the manual checklist.

### Schemas and formats

* Docs: Markdown / MDX with optional YAML front matter.
* Allowlist entries: TOML, `Word = "Word"` under `[default.extend-words]`, with a short comment above explaining the term (matching the existing file).
* Images: PNG (the guide's own examples in `static/img/repo/` are `.webp`, but new screenshots must be PNG per the guide).

### Concurrency, agents, re-runs, backups

* No agents, parallelism, state files, backups, or incremental logic. It runs inline in the current Claude session.
* Re-running it just re-applies the same guidance to whatever docs task is at hand.
* Safety comes from git. Note that Bryan's machine has an auto-commit job that may commit and push working-tree changes (see memory note), so unreviewed doc edits can reach the fork's remote.

### Safety rules and limits

* Only add spelling allowlist entries for terms that are correct. Fix real typos in the doc.
* Do not invent new structural patterns; copy the closest existing doc in the same section.
* The guide beats any restated rule (including this manual) because the skill intentionally avoids duplicating it.

### Failure modes

* **Broken link or anchor:** build throws. Usually a `/docs/...` URL instead of a relative `.md` path, or a heading renamed without updating `#anchor` links.
* **Two H1s, or an H1 plus a front-matter `title`:** breaks the one-title rule and the rendered sidebar.
* **Spell-check failure in CI:** a real misspelling, or a correct term that `typos` flags and nobody allowlisted.
* **Wrong image path or prefix:** fails review, or the image does not render.
* **Time-bound wording** ("as of the June update"): fails review.
* **Guide missing or moved:** SKILL.md hard-codes the path `packages/docs/docs/contributing/writing-docs.md`. If upstream moves it, the skill has nothing to read. What Claude should do in that case is not specified.

### Dependencies

* No MCP servers, API keys, or external CLIs are needed to follow the skill.
* For optional verification: Node and Yarn with the monorepo installed (`yarn install`), Docusaurus via the `docs` workspace, and `typos` if you want to run the spell-check locally (CI runs it).

### Related skills and docs in the same repo

Sibling skills in `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/`:
* `committing-actual-changes`: committing work in this repo.
* `review-actual-pr`: reviewing pull requests.
* `running-vrts`: visual regression tests.
* `writing-release-notes`: the release-notes files under `upcoming-release-notes/`. A docs PR may also need one; check that skill.

Background: `~/BGit/Bryan_git/actual_budget_bryan/AGENTS.md` (monorepo guide; describes `packages/docs/` as the Docusaurus site) and `packages/docs/docs/contributing/index.md` (contributor rules that AGENTS.md references).
