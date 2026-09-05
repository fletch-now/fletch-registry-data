import test from "node:test";
import assert from "node:assert/strict";
import { apiUrl, retryWaitMs, API_BASE } from "../scripts/api.mjs";

test("apiUrl points at fletch.now and drops empty params", function () {
  const url = apiUrl("/chains/4663/lookalikes", { limit: 1000, offset: 0, symbol: undefined });
  assert.equal(API_BASE, "https://fletch.now/api/v1");
  assert.equal(url.toString(), "https://fletch.now/api/v1/chains/4663/lookalikes?limit=1000&offset=0");
});

test("retryWaitMs honours Retry-After up to a minute and backs off otherwise", function () {
  assert.equal(retryWaitMs("5", 0), 5_000);
  assert.equal(retryWaitMs("3600", 0), 60_000);
  assert.equal(retryWaitMs("Wed, 21 Oct 2026 07:28:00 GMT", 1), 4_000);
  assert.equal(retryWaitMs(null, 2), 8_000);
});
