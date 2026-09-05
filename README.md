# fletch-registry-data

Daily git snapshots of every Stock Token, known lookalike and registry event on Robinhood Chain (chain id 4663), pulled from the public Fletch API at `https://fletch.now/api/v1`; `data/verify.json` alone is read from the chain's public RPC by `scripts/verify.mjs`. Each snapshot is a commit, so `git log -p data/` is the history and `git diff` between two days is the change.

[fletch.now/developers](https://fletch.now/developers) · [API reference](https://fletch.now/api/v1/docs) · [Registry](https://fletch.now/registry) · [llms.txt](https://fletch.now/llms.txt)

## Files

| File | Contents | Source |
| --- | --- | --- |
| `tokenlist.json` | A [Uniswap Token List](https://github.com/Uniswap/token-lists) of the confirmed canonical Stock Tokens, validated against `schema/tokenlist.schema.json` in CI | `/chains/4663/assets` |
| `data/assets.json` | Every asset the registry lists, with its live state, as the API returns it less Robinhood's `raw` listing payload and the ISIN (see `LICENSE-DATA.md`), sorted by symbol | `/chains/4663/assets` |
| `data/assets.csv` | One flat row per asset; the columns are listed in `scripts/lib.mjs` | same |
| `data/lookalikes.json` | The identity of every ERC-20 that borrows a listed ticker or exact name at another address: address, symbol, name, decimals, the ticker it claims, kind, exact-name flag, beacon, first seen | `/chains/4663/lookalikes` |
| `data/lookalike-counts.json` | Holder count, raw supply and last-seen time per lookalike address; kept apart so a diff of the identity file shows only arrivals and departures | same |
| `data/control-plane.json` | The issuer's AccessControlsRegistry as it stands (paused, implementation, blocked-address count) and its event log | `/chains/4663/control-plane` |
| `data/events.ndjson` | The registry changelog, one event per line, appended oldest first by cursor | `/chains/4663/events` |
| `data/cursor.txt` | The cursor the next run resumes from | same |
| `data/manifest.json` | When the snapshot was taken, the API's own status verdict at that moment, row counts, and whether each paged read completed | `/status` and the above |
| `data/verify.json` | The last full run of `scripts/verify.mjs`: each address's result and when the run started and finished | the public RPC |

`PROVENANCE.md` says where every field comes from, how an event id is derived and where history begins.

## The token list

A token is in the list when the API reports it as `assetType: stock_token`, `trust.level: confirmed` (the contract answers with the symbol and decimals Robinhood published) and `state.canonical: true` (its EIP-1967 beacon slot holds the issuer's AccessControlsRegistry). Bridged tokens, the stablecoin and the wrapped native token are in `data/assets.json` and not in the list. `state.canonical` is the daemon's last successful check (`state.checkedAt`); when `manifest.status.failingJobs` lists `canonical`, that check is older than the snapshot.

Addresses are EIP-55 checksummed. Names are the contract's own `name()` where the daemon has read it, else the listing name; the schema caps a name at 60 characters, and three listed names pass that cap only once the issuer's ` • Robinhood Token` suffix is removed, so a name over the cap is written without the suffix. Each token carries the tag `stock` and the extensions `registry` (its page on fletch.now) and `beacon`.

The version follows the Uniswap rule: major when a token leaves the list, minor when one arrives, patch when a token's details change. When nothing changed the file is not rewritten, so `timestamp` is the time the current version was made.

## Running a snapshot

```
npm ci
npm run snapshot   # writes tokenlist.json and data/
npm run verify     # re-reads every canonical beacon slot from the RPC
npm test
```

`.github/workflows/snapshot.yml` runs the same three commands every day at 06:17 UTC and commits `data/` and `tokenlist.json` when anything changed. The first snapshot made eight requests, paced at least 600 ms apart; the API allows 120 anonymous requests a minute.

The lookalike and control-plane reads page with `offset`. `manifest.json` records `complete: false` for either when a page came back full but added no new rows, which is what an API that ignores `offset` does; the files then hold the first page only (1000 lookalikes, 200 control-plane events).

## Verifying the canonical proof

`scripts/verify.mjs` takes every asset `data/assets.json` marks canonical, reads storage slot `0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50` (`keccak256("eip1967.proxy.beacon") - 1`) at `https://rpc.mainnet.chain.robinhood.com`, and checks the low 20 bytes equal `0xe10b6f6B275de231345c20D14Ab812db62151b00`, the AccessControlsRegistry. One read every 2.5 seconds after the previous answer, so a full pass over 194 assets takes at least eight minutes and longer when the RPC answers slowly; `startedAt` and `verifiedAt` in `data/verify.json` bound the last run. The file records each address's result, the addresses that could not be read (the RPC times out at times) and the addresses whose slot pointed elsewhere; the script exits 1 only for the latter.

This proves that the slot at each address points at the registry. It does not compare bytecode, so it does not on its own prove that the contract at the address is the issuer's proxy rather than a contract that wrote the same slot. `--symbols TSLA,AAPL` limits a run to named tokens and `--limit N` to the first N; neither writes `verify.json`.

## Licence

Everything outside `data/` and `tokenlist.json` is under MIT (`LICENSE`). Those files follow `LICENSE-DATA.md`: the columns Fletch derives (trust, canonical, kind, exact-name, first and last seen, event ids and titles, verdicts) are under CC BY 4.0, and fields reproduced from Robinhood and Blockscout are theirs.

Fletch is not affiliated with Robinhood Markets, Inc.
