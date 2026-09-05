// The one place these scripts talk to fletch.now. Every read is anonymous and
// paced so a whole snapshot stays well under the 120 requests a minute the API
// allows without a key; a 429 or a 5xx is retried rather than read as an
// empty page, because an empty page would be committed as fact.

import { readFile } from "node:fs/promises";

export const API_BASE = "https://fletch.now/api/v1";
export const CHAIN_ID = 4663;

const MIN_GAP_MS = 600;
const RETRIES = 4;
const REQUEST_TIMEOUT_MS = 30_000;
// Retry-After is honoured up to this; a server asking for an hour would
// otherwise hold the daily runner open for it.
const MAX_RETRY_AFTER_MS = 60_000;

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const USER_AGENT = `fletch-registry-data/${pkg.version} (+${pkg.repository.url})`;

let lastRequestAt = 0;

export function sleep(ms) {
  return new Promise(function wait(resolve) {
    setTimeout(resolve, ms);
  });
}

async function pace() {
  const wait = lastRequestAt + MIN_GAP_MS - Date.now();
  if (wait > 0) {
    await sleep(wait);
  }
  lastRequestAt = Date.now();
}

function backoffMs(attempt) {
  return 2_000 * 2 ** attempt;
}

// An HTTP-date Retry-After parses as NaN and falls back to the backoff.
export function retryWaitMs(retryAfterHeader, attempt) {
  const seconds = Number(retryAfterHeader);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
  }
  return backoffMs(attempt);
}

export function apiUrl(path, params = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export async function getJson(path, params = {}) {
  const url = apiUrl(path, params);
  let lastError = null;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    await pace();
    let response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (response.ok) {
      return response.json();
    }
    if (response.status === 429 || response.status >= 500) {
      lastError = new Error(`${response.status} from ${url.pathname}`);
      await sleep(retryWaitMs(response.headers.get("retry-after"), attempt));
      continue;
    }
    const body = (await response.text()).slice(0, 200);
    throw new Error(`${response.status} from ${url.pathname}: ${body}`);
  }
  throw lastError;
}
