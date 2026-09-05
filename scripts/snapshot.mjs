#!/usr/bin/env node
// One snapshot: read the public API, write the files under data/ and the
// token list at the root. Runs daily in .github/workflows/snapshot.yml and by
// hand with `npm run snapshot`. Nothing is inferred locally; every value in
// the output came back from fletch.now on this run, except events, which
// accumulate by cursor across runs.

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CHAIN_ID, getJson } from "./api.mjs";
import { assetsCsv, buildTokenList, collectEvents, collectPaged, isCanonicalStockToken, sortAssets, splitLookalikes, withoutListingPayload } from "./lib.mjs";

const ROOT = new URL("../", import.meta.url);
const DATA = new URL("data/", ROOT);
const TOKENLIST = new URL("tokenlist.json", ROOT);
const CURSOR_FILE = new URL("cursor.txt", DATA);
const EVENTS_FILE = new URL("events.ndjson", DATA);

// Before the daemon's first event, so a fresh clone pulls the whole changelog.
const FIRST_CURSOR = "2020-01-01T00:00:00.000Z";
const LOOKALIKE_PAGE = 1000;
const CONTROL_PAGE = 200;
const EVENT_PAGE = 500;

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function readJsonIfPresent(url) {
  if (!existsSync(url)) {
    return null;
  }
  return JSON.parse(await readFile(url, "utf8"));
}

async function writeJson(url, value) {
  await writeFile(url, `${JSON.stringify(value, null, 2)}\n`);
}

async function existingEventIds() {
  if (!existsSync(EVENTS_FILE)) {
    return new Set();
  }
  const text = await readFile(EVENTS_FILE, "utf8");
  const ids = new Set();
  for (const line of text.split("\n")) {
    if (line) {
      ids.add(JSON.parse(line).id);
    }
  }
  return ids;
}

async function snapshotAssets(now) {
  const body = await getJson(`/chains/${CHAIN_ID}/assets`);
  const assets = sortAssets(body.assets.map(withoutListingPayload));
  await writeJson(new URL("assets.json", DATA), assets);
  await writeFile(new URL("assets.csv", DATA), assetsCsv(assets));
  const previous = await readJsonIfPresent(TOKENLIST);
  const tokenlist = buildTokenList(assets, previous, now);
  if (tokenlist !== previous) {
    await writeJson(TOKENLIST, tokenlist);
  }
  const canonical = assets.filter(isCanonicalStockToken).length;
  log(`assets: ${assets.length} rows, ${canonical} canonical, tokenlist ${tokenlist.version.major}.${tokenlist.version.minor}.${tokenlist.version.patch}${tokenlist === previous ? " (unchanged)" : ""}`);
  return { assets: assets.length, canonical, tokens: tokenlist.tokens.length, tokenlistVersion: tokenlist.version };
}

async function snapshotLookalikes() {
  const result = await collectPaged(
    async function page(offset, limit) {
      const body = await getJson(`/chains/${CHAIN_ID}/lookalikes`, { limit, offset });
      return body.lookalikes;
    },
    { limit: LOOKALIKE_PAGE, key: (row) => row.address },
  );
  const { identity, counts } = splitLookalikes(result.rows);
  await writeJson(new URL("lookalikes.json", DATA), identity);
  await writeJson(new URL("lookalike-counts.json", DATA), counts);
  log(`lookalikes: ${identity.length} rows over ${result.pages} page(s)${result.complete ? "" : ", paging stopped early"}`);
  return { rows: identity.length, pages: result.pages, complete: result.complete };
}

async function snapshotControlPlane() {
  let state = null;
  const result = await collectPaged(
    async function page(offset, limit) {
      const body = await getJson(`/chains/${CHAIN_ID}/control-plane`, { limit, offset });
      state = state ?? body.state;
      return body.events;
    },
    { limit: CONTROL_PAGE, key: (row) => `${row.txHash}:${row.logIndex}` },
  );
  await writeJson(new URL("control-plane.json", DATA), { state, events: result.rows });
  log(`control-plane: ${result.rows.length} events over ${result.pages} page(s)${result.complete ? "" : ", paging stopped early"}`);
  return { events: result.rows.length, pages: result.pages, complete: result.complete };
}

async function appendEvents() {
  const startCursor = existsSync(CURSOR_FILE) ? (await readFile(CURSOR_FILE, "utf8")).trim() || FIRST_CURSOR : FIRST_CURSOR;
  const known = await existingEventIds();
  const result = await collectEvents(
    async function page(cursor, limit) {
      return getJson(`/chains/${CHAIN_ID}/events`, { cursor, limit });
    },
    startCursor,
    { limit: EVENT_PAGE },
  );
  // Dedupe within the run as well as against the file: rows observed in the
  // same millisecond as a page boundary can come back on both pages.
  const fresh = [];
  for (const event of result.events) {
    if (!known.has(event.id)) {
      known.add(event.id);
      fresh.push(event);
    }
  }
  if (fresh.length > 0) {
    await appendFile(EVENTS_FILE, `${fresh.map((event) => JSON.stringify(event)).join("\n")}\n`);
  }
  await writeFile(CURSOR_FILE, `${result.cursor}\n`);
  log(`events: ${fresh.length} appended over ${result.pages} page(s), cursor ${result.cursor}`);
  return { appended: fresh.length, total: known.size, cursor: result.cursor, complete: result.complete };
}

async function main() {
  const now = new Date();
  await mkdir(DATA, { recursive: true });
  const status = await getJson("/status");
  log(`status: ${status.verdict} (${status.summary})`);
  const assets = await snapshotAssets(now);
  const lookalikes = await snapshotLookalikes();
  const controlPlane = await snapshotControlPlane();
  const events = await appendEvents();
  await writeJson(new URL("manifest.json", DATA), {
    fetchedAt: now.toISOString(),
    api: "https://fletch.now/api/v1",
    chainId: CHAIN_ID,
    status: {
      verdict: status.verdict,
      summary: status.summary,
      checkedAt: status.checkedAt,
      headBlock: status.head?.block ?? null,
      headReadAt: status.head?.readAt ?? null,
      failingJobs: status.daemon?.failing ?? [],
    },
    assets,
    lookalikes,
    controlPlane,
    events,
  });
  log("manifest written");
}

main().catch(function fail(error) {
  log(`snapshot failed: ${error.stack ?? error}`);
  process.exit(1);
});
