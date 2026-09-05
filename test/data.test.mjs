// Checks the committed snapshot agrees with itself: the cursor is the last
// event line, ids are unique, every listed token is a known asset.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { eventCursor } from "../scripts/lib.mjs";

const ROOT = new URL("../", import.meta.url);
const DATA = new URL("data/", ROOT);
const hasSnapshot = existsSync(new URL("manifest.json", DATA));

async function json(name) {
  return JSON.parse(await readFile(new URL(name, DATA), "utf8"));
}

test("manifest, assets and tokenlist agree", { skip: !hasSnapshot }, async function () {
  const manifest = await json("manifest.json");
  const assets = await json("assets.json");
  const list = JSON.parse(await readFile(new URL("tokenlist.json", ROOT), "utf8"));
  assert.equal(manifest.chainId, 4663);
  assert.equal(assets.length, manifest.assets.assets);
  assert.equal(list.tokens.length, manifest.assets.tokens);
  const known = new Set(assets.map((asset) => asset.address.toLowerCase()));
  assert.ok(list.tokens.every((token) => known.has(token.address.toLowerCase())));
  assert.ok(assets.every((asset) => !("raw" in asset) && !("isin" in asset)));
  const csv = await readFile(new URL("assets.csv", DATA), "utf8");
  assert.equal(csv.trimEnd().split("\n").length, assets.length + 1);
});

test("lookalike identity and counts line up", { skip: !hasSnapshot }, async function () {
  const identity = await json("lookalikes.json");
  const counts = await json("lookalike-counts.json");
  const addresses = identity.map((row) => row.address);
  assert.equal(new Set(addresses).size, addresses.length);
  assert.ok(addresses.every((address) => address === address.toLowerCase()));
  assert.deepEqual(counts.map((row) => row.address), addresses);
});

test("events.ndjson has unique ids and cursor.txt names its last line", { skip: !hasSnapshot }, async function () {
  const lines = (await readFile(new URL("events.ndjson", DATA), "utf8")).split("\n").filter(Boolean);
  const events = lines.map((line) => JSON.parse(line));
  const ids = events.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => /^ev_[0-9a-f]{24}$/.test(id)));
  const cursor = (await readFile(new URL("cursor.txt", DATA), "utf8")).trim();
  assert.equal(cursor, eventCursor(events[events.length - 1]));
});

test("verify.json names only known assets and counts its own rows", { skip: !hasSnapshot || !existsSync(new URL("verify.json", DATA)) }, async function () {
  const verify = await json("verify.json");
  const assets = await json("assets.json");
  const known = new Set(assets.map((asset) => asset.address));
  assert.equal(verify.checked, verify.results.length);
  assert.equal(verify.proven + verify.mismatched.length + verify.unread.length, verify.checked);
  assert.ok(verify.results.every((row) => known.has(row.address)));
  assert.ok(verify.startedAt <= verify.verifiedAt);
});
