import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStatus, checkMarkets, checkProgress, fetchObservation, monitor, sanitize, LIMITS } from "../scripts/monitor.mjs";

const NOW = Date.parse("2026-09-10T20:00:00Z");
function iso(offset = 0) { return new Date(NOW + offset).toISOString(); }
function status(offset = 0, advance = 0) {
  return { chainId: 4663, checkedAt: iso(offset), verdict: "live",
    daemon: { alive: true, lastBeatAt: iso(offset) }, head: { block: String(100 + advance), readAt: iso(offset) },
    jobs: [{ job: "priority-pools", verdict: "fresh", error: null, metricCoverage: { price: {
      eligible: 1, current: 1, failed: 0, unread: 0, oldestInputAgeSeconds: 0, measuredAt: iso(offset),
    } } }], swapIndexer: { current: true, newestCountedAt: iso(offset), newestCountedBlock: String(99 + advance),
      priorityPoolCount: 1, priorityComplete24hPools: 1, priorityValued24hPools: 1 } };
}
function metric() {
  return { value: 10, source: "Fixture", asOf: iso(), reason: null, observation: {
    sourceId: "rpc:fixture", blockNumber: "99", blockHash: null, sourceAt: iso(), fetchedAt: iso(),
    expiresAt: iso(120_000), method: "fixture", parameters: {}, inputs: [],
    coverage: { status: "complete", scope: "fixture", windowStartAt: null, windowEndAt: null }, status: "current", readStatus: "ok",
  } };
}
function markets() {
  const row = { address: `0x${"1".repeat(40)}`, selection: { policy: "fixture", selectedAt: iso(), expiresAt: iso(120_000), status: "current" } };
  for (const key of ["priceUsd", "marketCapUsd", "volumeUsd24h", "swaps24h", "transactions24h", "totalSupplyRaw", "burnedRaw", "holders", "v3QuoteHoldingsUsd", "v4OnePercentDepthUsd"]) row[key] = metric();
  return { chainId: 4663, asOf: iso(), pageSize: 25, sort: "volume", items: [row] };
}

test("monitor validates observed healthy fixtures and forward checkpoints", function () {
  assert.deepEqual(checkStatus(status(), NOW).errors, []);
  assert.deepEqual(checkMarkets(markets(), NOW).errors, []);
  assert.deepEqual(checkProgress(status(), status(65_000, 50)), []);
});

test("malformed, stale and upstream failed status cannot pass HTTP 200", function () {
  assert.ok(checkStatus({}, NOW).errors.length > 0);
  assert.ok(checkStatus(status(), NOW + 130_000).errors.length >= 3);
  const reading = status();
  reading.jobs[0].error = "HTTP 402";
  reading.jobs[0].verdict = "failing";
  assert.ok(checkStatus(reading, NOW).errors.some((error) => error.includes("unhealthy")));
  assert.equal(checkProgress(status(), status(65_000)).length, 2);
  assert.equal(checkProgress(status(), status(65_000, -1)).length, 2);
});

test("expired values and missing observations fail; unavailable coverage is reported", function () {
  const reading = markets();
  reading.items[0].priceUsd.observation.expiresAt = iso(-1);
  assert.ok(checkMarkets(reading, NOW).errors.some((error) => error.includes("expired")));
  delete reading.items[0].priceUsd.observation;
  assert.ok(checkMarkets(reading, NOW).errors.some((error) => error.includes("missing")));
  const partial = markets();
  partial.items[0].volumeUsd24h.value = null;
  partial.items[0].volumeUsd24h.observation.status = "missing";
  partial.items[0].volumeUsd24h.observation.readStatus = "unread";
  assert.equal(checkMarkets(partial, NOW).coverage.volumeUsd24h.unavailable, 1);
  assert.equal(checkMarkets(partial, NOW).partial.length, 1);
});

test("selection and nested input freshness remain independently enforceable", function () {
  const reading = markets();
  reading.items[0].dominantAddress = reading.items[0].address;
  reading.items[0].selection.expiresAt = iso(-1);
  assert.ok(checkMarkets(reading, NOW).errors.some((error) => error.includes("selection")));
  const input = metric();
  input.observation.expiresAt = iso(-1);
  reading.items[0].priceUsd.observation.inputs = [{ name: "quote", ...input }];
  assert.ok(checkMarkets(reading, NOW).errors.some((error) => error.includes("input") && error.includes("expired")));
  reading.items[0].priceUsd.observation.expiresAt = iso(-1);
  assert.equal(checkMarkets(reading, NOW).coverage.priceUsd.current, 0);
  const malformed = status();
  malformed.jobs = [null, { metricCoverage: { price: null } }];
  assert.ok(checkStatus(malformed, NOW).errors.some((error) => error.includes("malformed")));
});

test("HTTP failure and malformed JSON are recorded with bounded anonymous requests", async function () {
  const denied = await fetchObservation("https://fixture.invalid", async function (_, init) {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return new Response("sensitive error body", { status: 503 });
  });
  assert.equal(denied.error, "HTTP 503");
  assert.equal(denied.body, null);
  const malformed = await fetchObservation("https://fixture.invalid", async () => new Response("not-json"));
  assert.equal(malformed.error, "Malformed JSON");
});

test("failed runs retain sanitized artifacts without swallowing source failures", async function () {
  const directory = await mkdtemp(join(tmpdir(), "fletch-monitor-"));
  try {
    let now = NOW;
    let statuses = 0;
    const result = await monitor({ outputDir: directory, clock: () => now,
      wait: async function (ms) { assert.equal(ms, LIMITS.sampleMs); now += ms; },
      fetcher: async function (url) {
        if (url.includes("markets")) return new Response(null, { status: 502 });
        const body = status(statuses * LIMITS.sampleMs, statuses * 20);
        statuses += 1;
        body.secret = "fixture-secret";
        body.provider = "https://fixture.invalid/key?credential=secret";
        return Response.json(body);
      } });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "failed");
    assert.ok(result.errors.some((error) => error.includes("HTTP 502")));
    const saved = await readFile(join(directory, "report.json"), "utf8");
    assert.doesNotMatch(saved, /fixture-secret|credential=secret/);
    assert.equal(JSON.parse(saved).samples.markets.status, 502);
    assert.ok(JSON.parse(await readFile(join(directory, "initial.json"), "utf8")).first);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sanitizer removes credentials and URLs recursively", function () {
  assert.deepEqual(sanitize({ apiKey: "secret", nested: [{ message: "Bearer secret", url: "https://user:pass@host/key?secret=x" }] }),
    { apiKey: "[removed]", nested: [{ message: "Bearer [removed]", url: "[URL removed]" }] });
});
