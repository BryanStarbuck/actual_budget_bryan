---
category: Features
authors: [BryanStarbuck]
---

Add a loopback-only machine plane to the sync server (`/machine/v1`) and `abx`, an operator CLI that speaks it. The plane authenticates with a 256-bit machine key generated into `~/.credentials/actual_budget.json` at mode 0600 — nothing to type, and no credential in the repo. It refuses any request that did not arrive on the loopback socket, any request carrying a browser `Origin` or cross-site `Sec-Fetch-Site`, and any key that does not match in constant time.
