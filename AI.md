# Reading these snapshots with an agent

This repository is a dated dataset. Inspect `data/manifest.json` before selecting a
file: `fetchedAt` is when the API was copied, while each state field's checked time
is when that observation was actually made. `manifest.status` records the health
verdict at snapshot time. A later recovery never rewrites that historical verdict.
`complete` describes the snapshot's paging; it does not prove the underlying chain
scanner has read all history. The daily workflow is not a continuous live feed.

Use [live status](https://fletch.now/api/v1/status) and a narrow API query when a
current answer matters. [Agent overview](https://fletch.now/llms.txt),
[full agent reference](https://fletch.now/llms-full.txt) and
[OpenAPI](https://fletch.now/api/v1/openapi.json) describe the deployed contract.
Query a symbol or exact address and one bounded pool page instead of loading the
entire snapshot or registry into model context. Public registry reads need no key.

## Evidence and missing values

- Preserve raw integer strings and the token's own decimals. Never round an address
  or identify a token solely by ticker spelling.
- Null, missing and unread are unknown; none means zero. A current `live` job verdict
  can include incomplete `filling` history and stale rows. `metadataBacklog` reports
  actual due/unread counts at its own `measuredAt`.
- Pool `stateCurrent` requires an observation within ten minutes. Stale, future or
  unread state suppresses current price/depth/valuations/changes and retains the
  original `stateCheckedAt`. Price publication additionally depends on quote/depth
  evidence. Legacy swap fields can cover two UTC days; do not call them exact rolling
  24-hour activity or infer historical USD values from today's price.
- Confirmed, listed, community, lookalike and unknown reflect different evidence.
  Community metadata is not issuer verification. A lookalike label is a collision,
  not proof of its deployer's intent. Read provenance and the exact address.
- `verify.json` is a separate dated beacon-slot check. It is not a bytecode proof,
  a provider endorsement, an audit, or evidence that every other field is current.

## Updating and attribution

Run the existing snapshot workflow to create a new observation. Keep historical
commits, source timestamps, event cursors and explicit partial coverage. Do not edit
an old manifest to make it look healthy or replace unavailable measurements with
zero. The first-seen recording date can differ from contract creation.

Follow [PROVENANCE.md](PROVENANCE.md) and [LICENSE-DATA.md](LICENSE-DATA.md). This
snapshot exports listed assets and lookalike/event data; it does not claim a complete
archive of all discovered pools or all historical transfers. Private unreleased
indexing work is not represented here.

For bounded on-demand integration instructions, read [the live agent skill](https://fletch.now/skill.md).

## Live market filters

For current token pages, discover the [market filter catalog](https://fletch.now/api/v1/chains/4663/markets/filters)
and request [one market page](https://fletch.now/api/v1/chains/4663/markets?page=1&pageSize=25).
These are live API reads, separate from this repository's dated asset snapshots.
Use the catalog's exact values and preserve metric-level sources and times.
Combined filters use AND; unavailable readings do not satisfy numeric thresholds.
V3 quote holdings and V4 bounded 1% depth remain separate measures.
