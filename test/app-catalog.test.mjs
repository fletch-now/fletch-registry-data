import test from "node:test";
import assert from "node:assert/strict";
import { collectAppCatalog } from "../scripts/lib.mjs";

function page(offset, symbols, nextOffset, total = 2) {
  return { offset, total, nextOffset, source: "https://nummus.robinhood.com/currency_pairs/", observedAt: "2026-09-13T20:00:00.000Z", ageSeconds: 12, stale: false, error: null,
    items: symbols.map(symbol => ({ symbol, status: "display_only", pairs: [] })) };
}
test("catalog retains all symbols and each page's source age", async function () {
  const result = await collectAppCatalog(async offset => offset === 0 ? page(0, ["FRONG"], 1) : page(1, ["PONS"], null));
  assert.deepEqual(result.items.map(row => row.symbol), ["FRONG", "PONS"]);
  assert.equal(result.complete, true);
  assert.equal(result.observations[1].ageSeconds, 12);
});
test("catalog refuses truncated, repeated or changing pages", async function () {
  await assert.rejects(collectAppCatalog(async () => page(0, ["FRONG"], null)), /before all/);
  await assert.rejects(collectAppCatalog(async offset => offset === 0 ? page(0, ["FRONG"], 1) : page(1, ["FRONG"], null)), /repeated/);
  await assert.rejects(collectAppCatalog(async offset => offset === 0 ? page(0, ["FRONG"], 1) : page(1, ["PONS"], null, 3)), /changed during/);
});
