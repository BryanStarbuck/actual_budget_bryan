@AGENTS.md
@.github/agents/pr-and-commit-rules.md

~/BGit/Bryan_git/actual_budget_bryan/
This directory above is our web app. It's going to be made open source, so we never put private data in this directory or anywhere under there.

Over here is where we read in the bank statements. Sometimes they start off as PDFs.
~/BGit/Bryan_git/Bryan_Arindom/bank_statements/

The directory below is a staging area that you can go process and create bank statements inside of. You can read the PDFs in the hierarchy for the parent bank_statements from Recursive. Find bank statements. You might find them in PDF or other formats. You might well create them in whatever kind of import format our actual budget or other software likes to use, and create them in the CSVs and their import formats and things like that.

We can make sure we don't prevent dupes. The bank statements might have dupes: multiple PDFs of the same month. We can make sure the directory imports below remove any dupes, so the data is unified and not duplicated.
~/BGit/Bryan_git/Bryan_Arindom/bank_statements/import/

The directory below is for part of the management specification files on how everything is going to work.
~/BGit/Bryan_git/actual_budget_bryan/pm/
apis.mdx
cli.mdx
mcp.mdx

The directory below is where the source code goes for a CLI (command-line interface), where we can interface with this web app by using the CLI.
~/BGit/Bryan_git/actual_budget_bryan/cli/

Below is an MCP you can use. We'll have that as a node TypeScript MCP to work with Claude Code, so that way, from Claude Code, we can interact with that.
~/BGit/Bryan_git/actual_budget_bryan/mcp/

This is the prompt file our MCP server should use to know about our APIs and how to interact with the user:
~/BGit/Bryan_git/actual_budget_bryan/ai> ls
mcp_prompt.md
~/BGit/Bryan_git/actual_budget_bryan/ai



## Private Data Boundary: Never Leak Into the Open Source Repo

These two directory hierarchies, and everything under them recursively, hold Bryan's very private personal and financial data:
* ~/BGit/Bryan_git/Bryan_Arindom/bank_statements/
* ~/BGit/Bryan_git/Bryan_Arindom/bank_statements/import/

The directory below is an open source project that we own and publish:
* ~/BGit/Bryan_git/actual_budget_bryan/

HARD REQUIREMENT: Bryan's personal data must never end up anywhere in the ~/BGit/Bryan_git/actual_budget_bryan/ hierarchy. No exceptions.
* Never copy, move, symlink, or write any file from the private directories above into actual_budget_bryan/.
* Never put real data in code, tests, fixtures, sample files, docs, logs, commit messages, or comments there. That includes account numbers, balances, transactions, payees, statement text, names, and addresses.
* When actual_budget_bryan/ needs example data, make up synthetic data. Never derive it from the real statements.
* Scripts in actual_budget_bryan/ may read private files at runtime through a path the user supplies, but they must write their output outside that repo (for example, into bank_statements/import/), never inside it.
* Before committing anything in actual_budget_bryan/, check the staged diff for private data. If anything looks real, stop and ask Bryan.
* Never have Chase statements or Fidelity statements or financial data get into the git repo. But they will get into the database running on localhost that never gets into the git repo. 
* The data will get in. It is okay for the data to get into the database when we're on localhost, just not into the git repo or the directory hierarchy, because it may accidentally get into the public repo. 


