<p align="center">
  <img src="/demo.png" alt="Actualbudget" />
</p>

## About This Fork

This is a fork of [Actual Budget](https://github.com/actualbudget/actual), created and maintained by **Bryan Starbuck**.

Upstream Actual is an excellent budgeting app for people. This fork asks a different question: what does a budgeting app look like when an AI agent is a first-class user of it?

The goal is deep, practical AI integration — specifically with [Claude Code](https://claude.com/claude-code) — so that you can ask questions about your money in plain language and have the app do the work:

- **MCP support for the whole application.** An [MCP](https://modelcontextprotocol.io) server (`actual_budget`, tools prefixed `ab_`) exposes accounts, transactions, categories, budget months, payees, rules, schedules, a guarded ActualQL escape hatch, and the bank-statement import pipeline to Claude Code. Reads are always available; writes are off by default and require two independent switches plus an echoed confirmation.
- **A real operator CLI.** `abx` is the terminal front door to your install. It owns argument parsing and output formatting and nothing else — every balance, query, and reconciliation is computed by the running app. If the app is not up, `abx` starts it and waits for health before issuing a call.
- **Full API surface.** The CLI and the MCP server are both thin clients of the same localhost **machine plane** (`/machine/v1`) on the sync server, so anything one can do, the other can do, and so can your own scripts.
- **Security by construction.** The machine plane is loopback-only. It authenticates with a 256-bit key the app generates into `~/.credentials/actual_budget.json` at mode 0600 — nothing to type, nothing committed to the repo. It refuses any request that did not arrive on the loopback socket, any request carrying a browser `Origin` or cross-site `Sec-Fetch-Site`, and any key that does not match in constant time.

Design specs for this work live in [`pm/apis.mdx`](pm/apis.mdx) — the API contract both front doors are built on — plus [`pm/cli.mdx`](pm/cli.mdx) and [`pm/mcp.mdx`](pm/mcp.mdx). Everything upstream continues to work exactly as it always did.

Like upstream, this fork is **MIT licensed** — clone it, fork it, extend it, ship it.

## Getting Started

Actual is a local-first personal finance tool. It's 100% free and open source, written in Node.js, and it syncs your changes across devices without any heavy lifting on your part.

If you'd like to contribute, or just want to understand how development works, read the [contributing guide](https://actualbudget.org/docs/contributing/) — we'd love to have you.

Want to say thanks? Click the ⭐ at the top of the page.

## Key Links

- The Actual [Discord](https://discord.gg/pRYNYr4W5A) community
- The [Community Documentation](https://actualbudget.org/docs)
- [Frequently asked questions](https://actualbudget.org/docs/faq)

## Installation

There are four ways to run Actual:

1. One-click deployment [via PikaPods](https://www.pikapods.com/pods?run=actual) (~$2.00/month) — recommended if you'd rather not manage a server
1. Managed hosting [via Fly.io](https://actualbudget.org/docs/install/fly) (~$1.50/month)
1. Self-hosted with [a Docker image](https://actualbudget.org/docs/install/docker)
1. Local-only — [downloadable Windows, Mac, and Linux apps](https://actualbudget.org/download/) that run on your device

See the [installation instructions](https://actualbudget.org/docs/install/) for details.

## Ready to Start Budgeting?

Read about [envelope budgeting](https://actualbudget.org/docs/getting-started/envelope-budgeting) to understand the idea behind Actual Budget.

### New to budgeting, or starting over?

The community's [Starting Fresh](https://actualbudget.org/docs/getting-started/starting-fresh) guide will get you up and running quickly.

### Migrating from another budgeting app?

The community's [Migration](https://actualbudget.org/docs/migration/) guide covers moving your data across.

## Documentation

The [Community Documentation](https://actualbudget.org/docs) covers budgeting, account management, tips and tricks, and developer topics.

## Contributing

Actual is a community-driven product. Learn more about [contributing to Actual](https://actualbudget.org/docs/contributing/).

### Code structure

The app is split into a few packages:

- **loot-core** — the core application, which runs on any platform
- **desktop-client** — the desktop UI
- **desktop-electron** — the desktop app

This fork adds two more, outside `packages/` so they never collide with an upstream merge:

- **cli** — the `abx` operator CLI
- **mcp** — the `actual_budget` MCP server for Claude Code

For more on the project layout, see the [community documentation](https://actualbudget.org/docs/contributing/project-details).

### Feature Requests

Browse current feature requests [here](https://github.com/actualbudget/actual/issues?q=is%3Aissue+label%3A%22needs+votes%22+sort%3Areactions-%2B1-desc), and vote for your favorites by reacting :+1: to the top comment. To add a new one, open an Issue of the "Feature Request" type.

### Translation

Help make Actual Budget accessible to more people by contributing to [internationalization](https://actualbudget.org/docs/contributing/i18n/). Translations are crowd-sourced through our [Weblate project](https://hosted.weblate.org/projects/actualbudget/). Weblate proudly supports open-source projects through their [Libre plan](https://weblate.org/en/hosting/#libre).

<a href="https://hosted.weblate.org/engage/actualbudget/">
<img src="https://hosted.weblate.org/widget/actualbudget/actual/287x66-grey.png" alt="Translation status" />
</a>

## Repo Activity

![Alt](https://repobeats.axiom.co/api/embed/e20537dd8b74956f86736726ccfbc6f0565bec22.svg 'Repobeats analytics image')

## Sponsors

Thanks to the wonderful sponsors who make Actual Budget possible!

<a href="https://www.netlify.com"><img src="https://www.netlify.com/v3/img/components/netlify-color-accent.svg" alt="Deploys by Netlify" /></a>
<a href="https://depot.dev"><img src="https://depot.dev/badges/built-with-depot.svg" alt="Built with Depot" /></a>
<a href="https://www.docker.com"><img src="https://www.docker.com/app/uploads/2023/05/symbol_blue-docker-logo.png" alt="Docker" height="48" /></a>
<a href="https://github.com"><img src="https://avatars.githubusercontent.com/u/9919?s=200&v=4" alt="GitHub" height="48" /></a>
<a href="https://www.anthropic.com"><img src="https://avatars.githubusercontent.com/u/76263028?s=200&v=4" alt="Anthropic" height="48" /></a>
