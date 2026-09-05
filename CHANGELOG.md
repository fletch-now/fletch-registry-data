# Changelog

## 0.1.0 - 2026-09-05

First snapshot. `scripts/snapshot.mjs` writes `tokenlist.json`, `data/assets.json`, `data/assets.csv`, `data/lookalikes.json`, `data/lookalike-counts.json`, `data/control-plane.json`, `data/events.ndjson` with `data/cursor.txt`, and `data/manifest.json` from the public Fletch API. Each asset is written without Robinhood's `raw` listing payload and ISIN (`LICENSE-DATA.md` says why), and a token-list name is the contract's own `name()` where the daemon has read it. `scripts/verify.mjs` re-reads the beacon slot of every canonical asset from the public RPC and writes `data/verify.json`. A daily workflow commits what changed and fails after the commit when a proof did.
