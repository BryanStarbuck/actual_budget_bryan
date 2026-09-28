# running-vrts — Instructions

## At a glance

* **What it is:** a knowledge/procedure skill for the Actual Budget repo (`~/BGit/Bryan_git/actual_budget_bryan`, a fork of actualbudget/actual). It teaches Claude how to add, update, regenerate, run, and debug visual regression tests (VRTs), which are screenshot tests.
* **What it carries out:** it writes or edits a Playwright e2e test that calls `expect(target).toMatchThemeScreenshots()`. It checks the flow without screenshots, generates Linux snapshot PNGs inside the Playwright docker image, and runs the same command again to confirm they pass.
* **Who runs it:** a developer (or Claude working for one) making a UI change in the Actual Budget web client that needs screenshot coverage, or fixing a failing VRT.
* **When:** it loads automatically on phrases like "add a VRT", "add a screenshot test", "update the snapshots", "regenerate the VRT screenshots", "the VRT is failing", "yarn vrt", "vrt:docker", or "/update-vrt".
* **How to invoke:** `/running-vrts`, or just ask in plain words, e.g. "add a VRT for the new category popover in transactions.test.ts".
* **Inputs:** required: the test to cover (file plus test name, or the UI change). Optional: the host URL of the dev server, and whether docker is available.
* **Where to run from:** the repo root `~/BGit/Bryan_git/actual_budget_bryan/`. Every yarn and docker command is run from there, because the root is mounted into the container as `/work`.
* **Where results land:** snapshots go in `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/e2e/<file>.test.ts-snapshots/<Describe>-<test-name>-N-chromium-linux.png`, and tests go in `.../packages/desktop-client/e2e/*.test.ts`.
* **Three PNGs per assertion:** each call captures the `auto` (light), `dark`, and `midnight` themes. A test with 2 assertions produces 6 PNGs.
* **What it will not touch:** it never runs an unscoped `--update-snapshots` (that would rewrite every screenshot in the repo), and it never commits `-chromium-darwin.png` files made on the host.
* **Biggest gotcha:** snapshots made on macOS are named `-darwin.png`, and CI ignores them. They must be generated in `mcr.microsoft.com/playwright:v1.61.1-jammy`. From a Mac, the container must reach the dev server at the LAN IP (`ipconfig getifaddr en0`), not at `localhost`.
* **Fallback:** if docker is not available, commit only the test file. Then comment `/update-vrt` on the PR and CI generates the snapshots. Commit messages need the `[AI]` prefix (see the committing-actual-changes skill).

## How it works

### Purpose

Actual Budget guards its UI with screenshot tests. They are not a separate framework: they are ordinary Playwright e2e tests in `packages/desktop-client/e2e/*.test.ts` that call a custom matcher, `toMatchThemeScreenshots()`, defined in `packages/desktop-client/e2e/fixtures.ts`. The skill exists because two mistakes are easy to make and costly:

1. Generating snapshots on the macOS host. They come out named `-chromium-darwin.png`, and CI never looks at them.
2. Running `--update-snapshots` without a filter. That silently regenerates every screenshot in the repo.

The skill gives Claude a safe, repeatable procedure that avoids both.

### The matcher's two modes

- **Without `VRT=true`** (a normal e2e run), the matcher returns "passed" at once. This lets you check the interaction flow cheaply with no snapshots:
  `yarn workspace @actual-app/web run playwright test <file> -g "<name>"`. The skill says to always do this first.
- **With `VRT=true`** (what `yarn vrt` sets through `cross-env VRT=true npx playwright test --browser=chromium`), the matcher does four things in order:
  1. Switches `window.Actual.setTheme` to `auto`, `dark`, then `midnight`.
  2. Waits for the `[data-theme]` attribute to match each theme.
  3. Takes one screenshot per theme, masking any `[data-vrt-mask="true"]` elements.
  4. Switches back to `auto`.

### Writing a test

- Import `{ expect, test }` from `./fixtures`, not from `@playwright/test`.
- Screenshot a tight locator, such as a `[data-popover]` popover or a single panel, rather than the whole page. This cuts down noise from charts and data.
- The demo budget (`ConfigurationPage.createTestFile()`) has pinned data, with date ranges showing 2016, so its screenshots mostly stay the same from day to day.
- Put `data-vrt-mask="true"` on content that changes between runs, such as real dates and version numbers.
- Patterns to copy:
  - `e2e/transactions.test.ts` (the "by date" date-picker popover)
  - `e2e/reports.test.ts`
- Page models are in `e2e/page-models/`.

### The typical run (docker, local)

1. From the repo root, start the dev server in the background with `HTTPS=true yarn start`. Wait until `https://localhost:3001` returns 200.
2. Work out the host the container should use:
   - On Linux, use `localhost`.
   - On macOS or Windows, use the LAN IP (`ipconfig getifaddr en0`).
3. Run the docker image yourself. The `bin/run-vrt` wrapper passes `-it`, which fails without a TTY, so an agent cannot use it.
   ```sh
   docker run --rm --network host -v "$(pwd)":/work/ -w /work/ \
     mcr.microsoft.com/playwright:v1.61.1-jammy /bin/bash -c \
     "E2E_START_URL=https://<HOST>:3001 yarn vrt --update-snapshots -g '<test name>' <file>.test.ts"
   ```
4. Always limit the run to the new or changed test with `-g` and the file name.
5. Run the same command again without `--update-snapshots`. It must pass.
6. Optionally, open one PNG to check that it shows the intended UI.
7. Commit the test and the PNGs with an `[AI]`-prefixed message.

### Run modes

| Mode | Command | Use |
|---|---|---|
| Flow check, no screenshots | `yarn workspace @actual-app/web run playwright test <file> -g "<name>"` | Always first. Cheap. |
| Generate snapshots (agent) | `docker run ... yarn vrt --update-snapshots -g ... <file>` | Create or refresh the PNGs for one test |
| Verify snapshots | same docker command without `--update-snapshots` | Must pass |
| Human wrapper | `yarn vrt:docker --e2e-start-url https://<HOST>:3001 --update-snapshots` | Interactive terminal only (`-it`) |
| No docker | commit the test, comment `/update-vrt` on the PR | CI makes the PNGs |

### Worked example

You ask: "Add a VRT for the new split-transaction popover."

Claude then:
1. Adds `await expect(page.locator('[data-popover]')).toMatchThemeScreenshots();` to a test in `e2e/transactions.test.ts`.
2. Runs the plain Playwright flow check.
3. Starts `HTTPS=true yarn start` and gets `192.168.1.20` from `ipconfig getifaddr en0`.
4. Runs the docker command with `E2E_START_URL=https://192.168.1.20:3001 yarn vrt --update-snapshots -g 'split popover' transactions.test.ts`.
5. Runs it again without the update flag and confirms three new `Transactions-split-popover-{1,2,3}-chromium-linux.png` files.
6. Commits them with an `[AI] ...` message.

## Full detail

### Steps in order (as the skill specifies)

1. **Write or locate the test.** It lives in `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/e2e/<area>.test.ts` and imports from `./fixtures`. Desktop and mobile tests are separate files, for example `transactions.test.ts` and `transactions.mobile.test.ts`.
2. **Flow check.** Run the test without `VRT`. `toMatchThemeScreenshots()` is a no-op here. In non-VRT runs `fixtures.ts` also turns off CSS transitions and animations through an init script on `browser.newPage`. In VRT runs the plain Playwright `test` is used and that init script is not installed.
3. **Start the dev server.** Run `HTTPS=true yarn start` from the repo root in the background. It is ready when `https://localhost:3001` returns 200.
4. **Pick the host.** On Linux, `localhost` works directly. On macOS or Windows, the container runs with `--network host` but cannot reach the host's localhost, so use the LAN IP (`ipconfig getifaddr en0` on macOS).
5. **Generate.** Run the scoped docker command with `--update-snapshots`. Pin the image tag to `@playwright/test` in `packages/desktop-client/package.json`. It is currently `1.61.1`, so the tag is `v1.61.1-jammy`.
6. **Verify.** Run the identical command without `--update-snapshots`. It must pass.
7. **Sanity-check and commit.** Optionally Read one PNG. Commit the test and the PNGs, with messages that start with `[AI]`.

### Input files it reads

- `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/e2e/fixtures.ts`: defines the matcher, the theme sequence, and masking.
- `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/playwright.config.ts`: sets these values:
  - `toHaveScreenshot: { maxDiffPixels: 5, threshold: 0.05 }`
  - `ignoreHTTPSErrors: true`
  - `baseURL` from `E2E_START_URL`, otherwise `http://localhost:<e2ePort>`
  - `webServer` is skipped when `E2E_START_URL` is set
- `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/package.json`: the `e2e`, `vrt`, and `playwright` scripts, and the `@playwright/test` version.
- `~/BGit/Bryan_git/actual_budget_bryan/package.json`: the root scripts `vrt` (`yarn workspace @actual-app/web run vrt`) and `vrt:docker` (`./bin/run-vrt`).
- `~/BGit/Bryan_git/actual_budget_bryan/bin/run-vrt`: the wrapper script. It:
  - runs `yarn` if `node_modules` is missing or empty
  - defaults `E2E_START_URL` to `https://localhost:3001`
  - accepts `--e2e-start-url`
  - runs `docker run ... -it mcr.microsoft.com/playwright:v1.61.1-jammy`
- Example tests: `e2e/transactions.test.ts` and `e2e/reports.test.ts`. Page models are in `e2e/page-models/` (for example `configuration-page.ts`, `account-page.ts`, `budget-page.ts`).

### Output files it writes

- New or edited test files under `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/e2e/`.
- Snapshot PNGs under `~/BGit/Bryan_git/actual_budget_bryan/packages/desktop-client/e2e/<file>.test.ts-snapshots/`.
  - They are named `<Describe>-<test-name>-N-chromium-linux.png`.
  - `N` counts up per screenshot within the test: 1, 2, 3 are auto, dark, and midnight for the first assertion; 4, 5, 6 are for the second assertion; and so on.
  - Example: `Transactions-checks-the-page-visuals-1-chromium-linux.png`.
- A git commit, only if the user asks for one. Its message starts with `[AI]`.

### Format and tolerance rules

- The diff tolerance is strict: at most 5 differing pixels, with a per-pixel threshold of 0.05. Small colour changes will fail.
- Only `-chromium-linux.png` snapshots count. A macOS host writes `-chromium-darwin.png`, and CI ignores those files.

### Concurrency and agent behavior

The skill describes one sequential procedure. It does not spawn agents. The dev server runs in the background while the docker commands run in the foreground.

### Re-run and incremental behavior

- Re-running with `--update-snapshots` overwrites the PNGs for the tests that match `-g` and the file filter.
- Re-running without that flag compares against the committed PNGs.
- Leaving out the filter rewrites all snapshots. The skill forbids this.

### Backups

The skill makes no backups. Git is the only way back.

### Safety rules

- Always limit `--update-snapshots` with `-g` and file arguments.
- Never commit snapshots generated on the host.
- Don't use `bin/run-vrt` / `yarn vrt:docker` from a shell with no TTY, because `-it` fails there. Call `docker run` directly.
- Prefer tight locators, and mask content that changes between runs.

### Failure modes

- **Container cannot reach `localhost:3001` on macOS:** use the LAN IP.
- **Wrong image tag:** it differs from the repo's Playwright version, so screenshots render differently. Pin the tag to `@playwright/test`.
- **Flaky diffs from dates or versions:** add `data-vrt-mask="true"`.
- **Whole-page screenshots:** noise from charts and data. Use a tighter locator.
- **Missing snapshots in a normal e2e run:** nothing fails, because the matcher is a no-op without `VRT`. This can hide the fact that snapshots were never generated.

### CI and the no-docker fallback

- `~/BGit/Bryan_git/actual_budget_bryan/.github/workflows/vrt-update-generate.yml`:
  - triggered by a PR comment that starts with `/update-vrt`
  - runs in the untrusted fork context with read-only permissions
  - adds an "eyes" reaction to the comment and produces a patch artifact
- `.github/workflows/vrt-update-apply.yml`:
  - runs after the generate workflow and is gated by the `pr-automation` environment, which needs manual approval
  - checks that the patch contains only PNGs, then applies it to the PR branch
- `.github/workflows/e2e-vrt-comment.yml`: posts a sticky PR comment that links the VRT report when the "E2E Tests" workflow's VRT result is a failure.

### Dependencies

- Docker, with the image `mcr.microsoft.com/playwright:v1.61.1-jammy`.
- Yarn workspaces, Node, `cross-env`, and Playwright `1.61.1`.
- A local dev server over HTTPS on port 3001.
- No MCP servers or API keys are needed.

### Related skills

The sibling skills are in `~/BGit/Bryan_git/actual_budget_bryan/.claude/skills/`:

- `committing-actual-changes`: the `[AI]` prefix rule. It points to `.github/agents/pr-and-commit-rules.md`, and says not to fill in the PR template and not to skip hooks.
- `review-actual-pr`
- `writing-actual-docs`
- `writing-release-notes`

### Unclear or not specified

The skill does not say how to debug a failing VRT beyond regenerating or verifying. For example, it does not describe reading Playwright's diff images or the CI report artifact. It does not name a particular output directory for Playwright reports either.
