import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../scripts/verify.mjs";

test("parseArgs keeps the default pace and accepts a slower one", function () {
  assert.deepEqual(parseArgs([]), { paceMs: 2_500, symbols: null, limit: null });
  assert.equal(parseArgs(["--pace", "4000"]).paceMs, 4_000);
  assert.deepEqual([...parseArgs(["--symbols", "tsla, aapl"]).symbols], ["TSLA", "AAPL"]);
  assert.equal(parseArgs(["--limit", "2"]).limit, 2);
});

test("parseArgs refuses a pace that would remove the pacing", function () {
  assert.throws(() => parseArgs(["--pace", "abc"]), /--pace/);
  assert.throws(() => parseArgs(["--pace", "0"]), /--pace/);
  assert.throws(() => parseArgs(["--pace"]), /--pace needs a value/);
  assert.throws(() => parseArgs(["--limit", "1.5"]), /--limit/);
  assert.throws(() => parseArgs(["--symbols", "--limit", "1"]), /--symbols needs a value/);
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
});
