# Provenance

Everything in `data/` and `tokenlist.json` was read from `https://fletch.now/api/v1` by `scripts/snapshot.mjs`; `data/verify.json` was read from `https://rpc.mainnet.chain.robinhood.com` by `scripts/verify.mjs`. No value is computed here beyond sorting, flattening to CSV, checksumming addresses, shortening three token-list names and bumping the token-list version; the only fields removed are Robinhood's `raw` listing payload and the ISIN on each asset (see `LICENSE-DATA.md`).

## Where history begins

Fletch's registry daemon began recording on 2026-09-04. The first line of `data/events.ndjson` was observed at `2026-09-04T12:28:02.044Z`; nothing that happened on the chain before that day is in the changelog, and a control-plane event from an earlier block appears in `data/control-plane.json` because it was read from the chain's log, not because it was observed as it happened.

`firstSeenAt` on a lookalike is the day the lookalike scan first ran, not the day the token was deployed: 976 of the 1000 lookalikes in the first snapshot carry `2026-09-04`. `firstSeenAt` on an asset is the day the registry first read Robinhood's listing (`2026-09-02` for the 194 Stock Tokens, `2026-09-04` for the 11 bridged tokens, `2026-09-01` for USDG and WETH), not the day the token was listed or deployed.

## Where each field comes from

| Field | Origin |
| --- | --- |
| `assets[].symbol`, `name`, `decimals`, `status`, `state.multiplier`, `state.pendingMultiplier`, `state.multiplierEffectiveAt` | Robinhood's listing API (`sourceUri` names the endpoint), reproduced; the raw record, ISIN, logo URL and quote are not |
| `assets[].onchainName`, `onchainSymbol`, `onchainDecimals`, `state.tokenPaused`, `state.oraclePaused`, `state.totalSupplyRaw`, `state.beacon`, `state.implementation`; `control-plane.json` throughout; `lookalikes[].address`, `symbol`, `name`, `decimals`, `beacon`, `totalSupplyRaw` | Robinhood Chain, read over the public RPC by Fletch's daemon |
| `state.feed` | The Chainlink aggregator for the symbol, read on chain |
| `state.dex` | Uniswap v4 and v3 pools on Robinhood Chain, read on chain |
| `state.secondSource`, `lookalikes[].holders` | Blockscout's Robinhood Chain explorer API, reproduced |
| `trust`, `state.canonical`, `state.priceDivergencePct`, `lookalikes[].claims`, `kind`, `exactName`, `firstSeenAt`, `lastSeenAt`, every event's `id`, `kind`, `title`, `observedAt`, `manifest.status` | Derived by Fletch |

## Event ids

An event id is stable across re-runs of the daemon: writing the same change twice yields the same id, and the insert is ignored. The rule, as the daemon applies it:

```
subject = assetId ?? address ?? "chain"
moment  = key ?? txHash ?? occurredAt.toISOString()
id      = "ev_" + sha256(`${chainId}|${kind}|${subject}|${moment}`).hex().slice(0, 24)
```

`chainId` is 4663. `assetId` is `4663:<lowercase address>` of the listed asset the event concerns. Which `key` each kind supplies, and what `occurredAt` means for it:

| Kind | Subject | Moment (`key`, else `txHash`, else `occurredAt`) | `occurredAt` |
| --- | --- | --- | --- |
| `registry.paused`, `registry.unpaused`, `registry.upgraded`, `registry.blocked`, `registry.unblocked`, `registry.role` | The registry address `0xe10b6f6b275de231345c20d14ab812db62151b00` (no asset) | `<txHash>:<logIndex>` of the log | Timestamp of the block, or the time of the read when the block time could not be fetched |
| `token.paused`, `token.unpaused`, `oracle.paused`, `oracle.unpaused`, `token.halted`, `token.resumed`, `feed.stale`, `feed.fresh`, `token.canonical`, `token.noncanonical` | Asset id | No key and no txHash: the ISO time of the read | The time of the read that saw the flag flip |
| `multiplier.applied` | Asset id | The new multiplier as stored, a decimal string | The time of the read |
| `multiplier.scheduled` | Asset id | `<txHash>:<logIndex>` of the MultiplierScheduled log | Timestamp of the block, else the time of the read |
| `supply.residual`, `supply.reconciled` | Asset id | The UTC day `YYYY-MM-DD` of the audit | The time of the audit |
| `listing.new` | Asset id (for a bridged token, `4663:<address>`) | No key and no txHash: the ISO time the listing was first read | The time the listing was first read |
| `lookalike.found` | Asset id of the listed token being imitated; `address` is the lookalike | The lookalike's address | The time of the scan |
| `dex.pool_new` | Asset id | The pool id (v4 pool id or v3 pool address) | The time of the scan; `block` is the pool's creation block |
| `dex.premium` | Asset id | `<poolId>:<YYYY-MM-DDTHH>`, the hour of the observation | The time of the read |
| `bridge.deposit`, `bridge.withdrawal` | Asset id | `<txHash>:<logIndex>` of the gateway log | Timestamp of the block |
| `corporate.action` | Asset id | Robinhood's action id | The action's process date at 00:00 UTC, else the time of the read |
| `issuer.document_new`, `issuer.document_changed`, `issuer.document_gone` | Asset id when the document names one ticker, else `chain` | The document URL | The document's Last-Modified header, else the time of the read; for `_gone`, the time of the read |
| `issuer.page_changed`, `chain.notice_changed` | `chain` | `<page slug>:<first 12 hex of the page's sha256>` | The time of the read |
| `chain.upgrade` | `chain` | The new ArbOS version as a decimal string | The time of the read |
| `chain.owners_changed` | `chain` | The new owner set, lowercase, sorted, joined by `,` | The time of the read |
| `chain.degraded`, `chain.operational` | `chain` | No key and no txHash: the ISO time of the read | The time of the read |

Every event also carries `observedAt`, the time the daemon wrote the row. The changelog is ordered and paged by `observedAt` then `id`.

## The cursor

`data/cursor.txt` holds the API's `nextCursor`: `<observedAt>|<id>` of the last event appended. The next run asks `/chains/4663/events?cursor=<that>&limit=500` and receives only later rows, oldest first, until a page comes back shorter than 500. A fresh clone with no cursor starts from `2020-01-01T00:00:00.000Z`, which is before the daemon existed, and so pulls the whole changelog.

The daemon stores `observedAt` with microseconds and the cursor carries milliseconds, so a row written in the same millisecond as a page boundary can be sent on both pages; the snapshot dedupes by `id` before appending, and `test/data.test.mjs` asserts that every id in the file is unique.

## Paging the lookalikes and the control plane

`/chains/4663/lookalikes` returns at most 1000 rows and `/chains/4663/control-plane` at most 200 events per request. The snapshot walks both with `offset`, stopping at a short page. Lookalikes are ordered by holder count, which the scan refreshes, so rows can shift between pages read across a scan; the snapshot dedupes by address. Control-plane events come newest first; an event that lands between two page reads repeats one row on the next page, which the snapshot dedupes by `txHash:logIndex`. `manifest.json` records `complete: false` for a read whose second page repeated the first, which is what the API did before `offset` was accepted.
