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
cli.mdx
mcp.mdx

The directory below is where the source code goes for a CLI (command-line interface), where we can interface with this web app by using the CLI.
~/BGit/Bryan_git/actual_budget_bryan/cli/

Below is an MCP you can use. We'll have that as a node TypeScript MCP to work with Claude Code, so that way, from Claude Code, we can interact with that.
~/BGit/Bryan_git/actual_budget_bryan/mcp/
