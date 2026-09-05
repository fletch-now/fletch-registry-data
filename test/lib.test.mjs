import test from "node:test";
import assert from "node:assert/strict";
import { assetsCsv, buildTokenList, collectEvents, collectPaged, csvCell, isCanonicalStockToken, nextVersion, sortAssets, splitLookalikes, tokenListName, addressFromSlot, withoutListingPayload, NAME_SUFFIX } from "../scripts/lib.mjs";

function asset(overrides = {}) {
  return {
    chainId: 4663,
    address: "0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e",
    symbol: "AAOI",
    name: `Applied Optoelectronics${NAME_SUFFIX}`,
    onchainName: `Applied Optoelectronics${NAME_SUFFIX}`,
    assetType: "stock_token",
    decimals: 18,
    status: "active",
    isin: "US03823U1025",
    logoUrl: "https://cdn.robinhood.com/ncw_assets/logos/0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e.png",
    firstSeenAt: "2026-09-02T14:53:22.412Z",
    trust: { level: "confirmed" },
    state: { canonical: true, beacon: "0xe10b6f6b275de231345c20d14ab812db62151b00", multiplier: 1, quote: { bid: 1, ask: 2 } },
    ...overrides,
  };
}

test("tokenListName keeps short names and drops the issuer suffix from long ones", function () {
  assert.equal(tokenListName("Tesla • Robinhood Token"), "Tesla • Robinhood Token");
  const long = `Space Exploration Technologies Corp. Class A Common Stock${NAME_SUFFIX}`;
  assert.equal(tokenListName(long), "Space Exploration Technologies Corp. Class A Common Stock");
  assert.ok(tokenListName("x".repeat(80)).length <= 60);
});

test("only confirmed canonical stock tokens make the list", function () {
  assert.ok(isCanonicalStockToken(asset()));
  assert.ok(!isCanonicalStockToken(asset({ assetType: "bridged", state: null })));
  assert.ok(!isCanonicalStockToken(asset({ state: { canonical: false } })));
  assert.ok(!isCanonicalStockToken(asset({ trust: { level: "listed" } })));
});

test("buildTokenList checksums addresses and starts at 1.0.0", function () {
  const list = buildTokenList([asset(), asset({ assetType: "bridged", state: null, symbol: "WBTC" })], null, new Date("2026-09-05T00:00:00Z"));
  assert.deepEqual(list.version, { major: 1, minor: 0, patch: 0 });
  assert.equal(list.tokens.length, 1);
  assert.equal(list.tokens[0].address, "0x521Cf887E6531c6F667b5BC4D896E5d9bfE8EB2E");
  assert.ok(!("isin" in list.tokens[0].extensions));
  assert.equal(list.tokens[0].extensions.registry, "https://fletch.now/registry/AAOI");
});

test("a token-list name is the contract's own name when the daemon has read it", function () {
  const read = buildTokenList([asset({ name: "Listing name", onchainName: "Contract name" })], null, new Date());
  assert.equal(read.tokens[0].name, "Contract name");
  const unread = buildTokenList([asset({ name: "Listing name", onchainName: null })], null, new Date());
  assert.equal(unread.tokens[0].name, "Listing name");
});

test("withoutListingPayload drops raw, isin, logoUrl and the quote and keeps the rest", function () {
  const asset = {
    symbol: "AAPL",
    raw: { anything: true },
    isin: "US0378331005",
    logoUrl: "https://example.invalid/aapl.png",
    state: { beacon: "0xe10b6f6b275de231345c20d14ab812db62151b00", canonical: true, multiplier: 1, quote: { bid: 1, ask: 2 } },
  };
  assert.deepEqual(withoutListingPayload(asset), {
    symbol: "AAPL",
    state: { beacon: "0xe10b6f6b275de231345c20d14ab812db62151b00", canonical: true, multiplier: 1 },
  });
});

test("sortAssets orders by symbol in one collation whatever the machine's locale", function () {
  const rows = ["EWY", "EWT", "cbBTC", "CBRS"].map((symbol) => asset({ symbol }));
  assert.deepEqual(sortAssets(rows).map((row) => row.symbol), ["cbBTC", "CBRS", "EWT", "EWY"]);
});

test("nextVersion follows the Uniswap bump rule and returns null when nothing changed", function () {
  const previous = buildTokenList([asset()], null, new Date());
  const same = buildTokenList([asset()], previous, new Date());
  assert.equal(same, previous);
  assert.deepEqual(nextVersion(previous, []), { major: 2, minor: 0, patch: 0 });
  const added = buildTokenList([asset(), asset({ symbol: "TSLA", address: "0x0000000000000000000000000000000000000001" })], previous, new Date());
  assert.deepEqual(added.version, { major: 1, minor: 1, patch: 0 });
  const renamed = buildTokenList([asset({ onchainName: "Renamed" })], previous, new Date());
  assert.deepEqual(renamed.version, { major: 1, minor: 0, patch: 1 });
});

test("csv cells escape quotes, commas and newlines", function () {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(3), "3");
  assert.equal(csvCell('a "b", c'), '"a ""b"", c"');
  assert.equal(csvCell("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell("+1,2"), "\"'+1,2\"");
  const csv = assetsCsv([asset({ name: "One, Two" })]);
  const [header, row] = csv.split("\n");
  assert.equal(header.split(",")[0], "symbol");
  assert.ok(row.includes('"One, Two"'));
});

test("splitLookalikes sorts by address and separates counts", function () {
  const rows = [
    { address: "0xb", symbol: "B", name: "B", decimals: 18, holders: 2, totalSupplyRaw: "1", claims: "TSLA", kind: "unverified", exactName: false, beacon: null, firstSeenAt: "t0", lastSeenAt: "t1" },
    { address: "0xa", symbol: "A", name: "A", decimals: 18, holders: 5, totalSupplyRaw: "2", claims: "TSLA", kind: "unverified", exactName: true, beacon: null, firstSeenAt: "t0", lastSeenAt: "t1" },
  ];
  const { identity, counts } = splitLookalikes(rows);
  assert.deepEqual(identity.map((row) => row.address), ["0xa", "0xb"]);
  assert.ok(!("holders" in identity[0]));
  assert.deepEqual(counts[0], { address: "0xa", holders: 5, totalSupplyRaw: "2", lastSeenAt: "t1" });
});

test("collectPaged stops on a short page and dedupes by key", async function () {
  const pages = [[{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 3 }], [{ id: 4 }]];
  const calls = [];
  const result = await collectPaged(async function page(offset, limit) {
    calls.push([offset, limit]);
    return pages[offset / limit] ?? [];
  }, { limit: 2, key: (row) => row.id });
  assert.deepEqual(result.rows.map((row) => row.id), [1, 2, 3, 4]);
  assert.deepEqual(calls, [[0, 2], [2, 2], [4, 2]]);
  assert.equal(result.complete, true);
});

test("collectPaged stops when the server ignores offset", async function () {
  const result = await collectPaged(async function page() {
    return [{ id: 1 }, { id: 2 }];
  }, { limit: 2, key: (row) => row.id });
  assert.deepEqual(result.rows.map((row) => row.id), [1, 2]);
  assert.equal(result.pages, 2);
  assert.equal(result.complete, false);
});

test("collectEvents follows nextCursor until a short page and keeps the start cursor when empty", async function () {
  const pages = { start: { events: [{ id: "a", observedAt: "t1" }, { id: "b", observedAt: "t2" }], nextCursor: "t2|b" }, "t2|b": { events: [{ id: "c", observedAt: "t3" }], nextCursor: "t3|c" } };
  const result = await collectEvents(async (cursor) => pages[cursor], "start", { limit: 2 });
  assert.deepEqual(result.events.map((event) => event.id), ["a", "b", "c"]);
  assert.equal(result.cursor, "t3|c");
  const empty = await collectEvents(async () => ({ events: [], nextCursor: "ignored" }), "start", { limit: 2 });
  assert.equal(empty.cursor, "start");
  assert.equal(empty.events.length, 0);
});

test("addressFromSlot reads the low 20 bytes and treats zero as empty", function () {
  assert.equal(addressFromSlot("0x000000000000000000000000e10b6f6B275de231345c20D14Ab812db62151b00"), "0xe10b6f6b275de231345c20d14ab812db62151b00");
  assert.equal(addressFromSlot(`0x${"0".repeat(64)}`), null);
  assert.equal(addressFromSlot(undefined), null);
});
