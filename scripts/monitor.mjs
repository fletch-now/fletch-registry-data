#!/usr/bin/env node
// Anonymous reads from a runner outside the service host. No snapshot writes.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ENDPOINTS = {
  status: "https://fletch.now/api/v1/status",
  markets: "https://fletch.now/api/v1/chains/4663/markets?pageSize=25&sort=volume",
};
export const LIMITS = { statusMs: 30_000, daemonMs: 60_000, headMs: 90_000, swapsMs: 120_000, requestMs: 20_000, sampleMs: 65_000 };
const METRICS = ["priceUsd", "marketCapUsd", "volumeUsd24h", "swaps24h", "transactions24h", "totalSupplyRaw", "burnedRaw", "holders", "v3QuoteHoldingsUsd", "v4OnePercentDepthUsd"];
const REQUIRED_METRICS = new Set(["priceUsd", "marketCapUsd", "volumeUsd24h", "swaps24h", "totalSupplyRaw"]);

export function sanitize(value, depth = 0) {
  if (depth > 16) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 2000)
    .replace(/https?:\/\/[^\s"<>]+/g, "[URL removed]")
    .replace(/Bearer\s+\S+/gi, "Bearer [removed]");
  if (Array.isArray(value)) return value.slice(0, 1000).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 200)
    .map(([key, item]) => [key, /password|secret|authorization|cookie|api.?key|credential/i.test(key) ? "[removed]" : sanitize(item, depth + 1)]));
  return value;
}

export async function fetchObservation(url, fetcher = fetch, clock = Date.now) {
  const result = { requestedAt: new Date(clock()).toISOString(), fetchedAt: null, status: null, error: null, body: null };
  try {
    const response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(LIMITS.requestMs) });
    result.status = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      result.error = `HTTP ${response.status}`;
      return result;
    }
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      bytes += chunk.length;
      if (bytes > 2_000_000) throw new Error("body_limit");
      chunks.push(chunk);
    }
    result.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    result.error = error instanceof SyntaxError ? "Malformed JSON" : "Request, timeout or response size failure";
  } finally {
    result.fetchedAt = new Date(clock()).toISOString();
  }
  return result;
}

function nullableTime(value) {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function fresh(value, now, maxAge) {
  const age = typeof value === "string" ? now - Date.parse(value) : NaN;
  return Number.isFinite(age) && age >= -5000 && age <= maxAge;
}

function block(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null;
}

export function checkStatus(body, now) {
  const errors = [];
  const partial = [];
  if (!body || typeof body !== "object") return { errors: ["status: missing JSON object"], partial };
  if (body.chainId !== 4663) errors.push("status: unexpected chain");
  if (!fresh(body.checkedAt, now, LIMITS.statusMs)) errors.push("status: stale or missing response time");
  if (body.verdict !== "live") errors.push("status: service verdict is not live");
  if (body.daemon?.alive !== true || !fresh(body.daemon?.lastBeatAt, now, LIMITS.daemonMs)) errors.push("status: daemon heartbeat stale or missing");
  if (!fresh(body.head?.readAt, now, LIMITS.headMs) || block(body.head?.block) === null) errors.push("status: chain head stale or missing");
  if (!Array.isArray(body.jobs) || body.jobs.length === 0) errors.push("status: jobs missing");
  for (const job of Array.isArray(body.jobs) ? body.jobs : []) {
    if (!job || typeof job !== "object") { errors.push("status: malformed job"); continue; }
    if (!["fresh", "filling"].includes(job.verdict) || job.error) errors.push(`status: job ${String(job.job).slice(0, 80)} is unhealthy`);
    if (!("metricCoverage" in job)) errors.push("status: metric coverage contract missing");
    for (const counts of Object.values(job.metricCoverage ?? {})) {
      if (!counts || typeof counts !== "object") { errors.push("status: malformed metric coverage"); continue; }
      if (!["eligible", "current", "failed", "unread"].every((key) => Number.isInteger(counts[key]) && counts[key] >= 0)
        || !Number.isFinite(Date.parse(counts.measuredAt))
        || (counts.oldestInputAgeSeconds !== null && (!Number.isFinite(counts.oldestInputAgeSeconds) || counts.oldestInputAgeSeconds < 0))) errors.push("status: metric coverage malformed");
      if (counts.failed > 0) errors.push("status: failed metric reads reported");
      if (counts.current < counts.eligible) partial.push("status: metric coverage incomplete");
    }
    if (job.verdict === "filling") partial.push(`status: job ${String(job.job).slice(0, 80)} is filling`);
  }
  const swaps = body.swapIndexer;
  if (swaps?.current !== true || !fresh(swaps?.newestCountedAt, now, LIMITS.swapsMs) || block(swaps?.newestCountedBlock) === null) errors.push("status: swap checkpoint stale or missing");
  if (!Number.isInteger(swaps?.priorityPoolCount) || swaps.priorityPoolCount < 1) errors.push("status: priority pool coverage missing");
  else if (swaps.priorityComplete24hPools !== swaps.priorityPoolCount || swaps.priorityValued24hPools !== swaps.priorityPoolCount) partial.push("status: priority swap coverage incomplete");
  return { errors, partial };
}

function checkObservation(observation, value, now, prefix, errors, depth = 0) {
  if (!observation || typeof observation !== "object" || depth > 8) {
    errors.push(`${prefix}: structured observation missing or too deep`);
    return;
  }
  const fields = ["sourceId", "blockNumber", "blockHash", "sourceAt", "fetchedAt", "expiresAt", "method", "parameters", "inputs", "coverage", "status", "readStatus"];
  if (fields.some((field) => !(field in observation)) || !Array.isArray(observation.inputs)
    || typeof observation.method !== "string" || !observation.method
    || !["current", "stale", "missing", "invalid"].includes(observation.status)
    || !["ok", "partial", "failed", "unread"].includes(observation.readStatus)
    || !["complete", "partial", "unknown"].includes(observation.coverage?.status)
    || typeof observation.coverage?.scope !== "string"
    || !["sourceAt", "fetchedAt", "expiresAt"].every((key) => nullableTime(observation[key]))
    || !nullableTime(observation.coverage?.windowStartAt) || !nullableTime(observation.coverage?.windowEndAt)
    || !observation.parameters || typeof observation.parameters !== "object" || Array.isArray(observation.parameters)) errors.push(`${prefix}: observation contract malformed`);
  if (observation.readStatus === "failed") errors.push(`${prefix}: source read failed`);
  if (value !== null && value !== undefined) {
    if (observation.status !== "current") errors.push(`${prefix}: noncurrent value published`);
    if (typeof observation.sourceId !== "string" || !observation.sourceId) errors.push(`${prefix}: source identity missing`);
    for (const at of [observation.sourceAt, observation.fetchedAt]) {
      if (at !== null && Date.parse(at) > now + 5000) errors.push(`${prefix}: future source or fetch time`);
    }
    const expiry = Date.parse(observation.expiresAt);
    if (!Number.isFinite(expiry) || expiry < now) errors.push(`${prefix}: value expired or expiry missing`);
  }
  for (const input of Array.isArray(observation.inputs) ? observation.inputs : []) {
    checkObservation(input?.observation, input?.value, now, `${prefix}.input`, errors, depth + 1);
  }
}

export function checkMarkets(body, now) {
  const errors = [];
  const partial = [];
  const coverage = {};
  if (!body || !Array.isArray(body.items) || body.items.length === 0) return { errors: ["markets: rows missing"], partial, coverage };
  if (body.chainId !== 4663 || body.pageSize !== 25 || body.sort !== "volume" || body.items.length > 25) errors.push("markets: page contract malformed");
  if (!fresh(body.asOf, now, LIMITS.statusMs)) errors.push("markets: stale or missing page time");
  for (const [index, row] of body.items.entries()) {
    if (!row || typeof row !== "object") { errors.push(`markets[${index}]: malformed row`); continue; }
    if (!/^0x[0-9a-f]{40}$/i.test(row.address ?? "")) errors.push(`markets[${index}]: address malformed`);
    const selection = row.selection;
    if (typeof selection?.policy !== "string" || !selection.policy || !nullableTime(selection.selectedAt) || !nullableTime(selection.expiresAt)
      || !["current", "stale", "missing", "invalid"].includes(selection.status)) errors.push(`markets[${index}]: selection contract missing`);
    if (row.dominantAddress && (selection?.status !== "current" || !Number.isFinite(Date.parse(selection.expiresAt))
      || Date.parse(selection.expiresAt) < now)) errors.push(`markets[${index}]: expired economic selection published`);
    for (const metric of METRICS) {
      const value = row[metric];
      const counter = coverage[metric] ??= { eligible: body.items.length, current: 0, unavailable: 0, failed: 0 };
      checkObservation(value?.observation, value?.value, now, `markets[${index}].${metric}`, errors);
      if (value?.observation?.readStatus === "failed") counter.failed += 1;
      if (value?.value !== null && value?.value !== undefined && value?.observation?.status === "current"
        && Number.isFinite(Date.parse(value.observation.expiresAt)) && Date.parse(value.observation.expiresAt) >= now) counter.current += 1;
      else counter.unavailable += 1;
    }
  }
  for (const [metric, counts] of Object.entries(coverage)) {
    if (REQUIRED_METRICS.has(metric) && counts.unavailable > 0) partial.push(`markets: ${metric} unavailable for ${counts.unavailable}/${counts.eligible} sampled tokens`);
  }
  return { errors, partial, coverage };
}

export function checkProgress(first, second) {
  const errors = [];
  for (const [name, start, end] of [
    ["head", first?.head?.block, second?.head?.block],
    ["swaps", first?.swapIndexer?.newestCountedBlock, second?.swapIndexer?.newestCountedBlock],
  ]) {
    if (block(start) === null || block(end) === null || block(end) <= block(start)) errors.push(`progress: ${name} did not advance across samples`);
  }
  return errors;
}

function outcomeFor(errors, partial) {
  if (errors.length > 0) return "failed";
  if (partial.length > 0) return "partial";
  return "passed";
}

export async function monitor({ fetcher = fetch, clock = Date.now, wait = (ms) => new Promise((done) => setTimeout(done, ms)), outputDir = "monitor-artifacts" } = {}) {
  const first = await fetchObservation(ENDPOINTS.status, fetcher, clock);
  const markets = await fetchObservation(ENDPOINTS.markets, fetcher, clock);
  const initial = checkStatus(first.body, Date.parse(first.fetchedAt));
  const marketCheck = checkMarkets(markets.body, Date.parse(markets.fetchedAt));
  await mkdir(outputDir, { recursive: true });
  // Keep first samples even if a runner is interrupted during the interval.
  await writeFile(resolve(outputDir, "initial.json"), JSON.stringify(sanitize({ first, markets }), null, 2));
  await wait(LIMITS.sampleMs);
  const second = await fetchObservation(ENDPOINTS.status, fetcher, clock);
  const final = checkStatus(second.body, Date.parse(second.fetchedAt));
  const errors = [...initial.errors, ...marketCheck.errors, ...final.errors, ...checkProgress(first.body, second.body)];
  for (const [name, observation] of Object.entries({ first, markets, second })) if (observation.error) errors.push(`${name}: ${observation.error}`);
  const partial = [...new Set([...initial.partial, ...marketCheck.partial, ...final.partial])];
  const result = { checkedAt: new Date(clock()).toISOString(), ok: errors.length === 0 && partial.length === 0,
    outcome: outcomeFor(errors, partial),
    errors, partial, coverage: marketCheck.coverage, limits: LIMITS, samples: { first, markets, second } };
  await writeFile(resolve(outputDir, "report.json"), JSON.stringify(sanitize(result), null, 2));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await monitor();
  console.log(JSON.stringify(sanitize({ outcome: result.outcome, errors: result.errors, partial: result.partial })));
  process.exitCode = result.ok ? 0 : 1;
}
