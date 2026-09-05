#!/usr/bin/env node
// Re-proves, against the public RPC, what data/assets.json says: that every
// asset marked canonical is a proxy whose EIP-1967 beacon slot holds the
// issuer's AccessControlsRegistry. One request every 2.5 seconds after the
// previous answer. Writes data/verify.json; exits 1 when any slot points
// elsewhere.

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { sleep } from "./api.mjs";
import { addressFromSlot, isCanonicalStockToken } from "./lib.mjs";

export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
// Verified on chain and in Blockscout's verified source, 2026-09-03.
export const ACCESS_CONTROLS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00";
// keccak256("eip1967.proxy.beacon") - 1
export const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

const DATA = new URL("../data/", import.meta.url);
const READ_ATTEMPTS = 3;

// The floor keeps a typo from turning the pace off against a public RPC.
const MIN_PACE_MS = 250;

function argValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} needs a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = { paceMs: 2_500, symbols: null, limit: null };
  for (let i = 0; i < argv.length; i += 2) {
    const arg = argv[i];
    if (arg === "--pace") {
      options.paceMs = Number(argValue(argv, i, arg));
      if (!Number.isFinite(options.paceMs) || options.paceMs < MIN_PACE_MS) {
        throw new Error(`--pace must be a number of milliseconds, at least ${MIN_PACE_MS}`);
      }
    } else if (arg === "--symbols") {
      options.symbols = new Set(argValue(argv, i, arg).split(",").map((s) => s.trim().toUpperCase()));
    } else if (arg === "--limit") {
      options.limit = Number(argValue(argv, i, arg));
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return options;
}

function mark(row) {
  if (row.proven) {
    return "ok  ";
  }
  if (row.error) {
    return "??  ";
  }
  return "FAIL";
}

function log(message) {
  process.stderr.write(`${message}\n`);
}

async function readSlot(client, address, paceMs) {
  let lastError = null;
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    try {
      const slot = await client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT });
      await sleep(paceMs);
      return { slot, error: null };
    } catch (error) {
      lastError = error;
      await sleep(paceMs);
    }
  }
  return { slot: null, error: String(lastError?.shortMessage ?? lastError?.message ?? lastError) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const assets = JSON.parse(await readFile(new URL("assets.json", DATA), "utf8"));
  let targets = assets.filter(isCanonicalStockToken);
  if (options.symbols) {
    targets = targets.filter((asset) => options.symbols.has(asset.symbol));
  }
  if (options.limit) {
    targets = targets.slice(0, options.limit);
  }
  const client = createPublicClient({ transport: http(RPC_URL, { retryCount: 0, timeout: 20_000 }) });
  const registry = ACCESS_CONTROLS_REGISTRY.toLowerCase();
  const results = [];
  const startedAt = new Date().toISOString();
  log(`verifying ${targets.length} canonical assets against ${RPC_URL}, one read every ${options.paceMs} ms`);
  for (const asset of targets) {
    const { slot, error } = await readSlot(client, asset.address, options.paceMs);
    const beacon = addressFromSlot(slot);
    const row = {
      symbol: asset.symbol,
      address: asset.address,
      beacon,
      apiBeacon: asset.state?.beacon ?? null,
      proven: beacon === registry,
      error,
    };
    results.push(row);
    log(`${mark(row)} ${asset.symbol.padEnd(6)} ${asset.address} ${beacon ?? error ?? "empty slot"}`);
  }
  const mismatched = results.filter((row) => row.error === null && !row.proven);
  const unread = results.filter((row) => row.error !== null);
  const summary = {
    startedAt,
    verifiedAt: new Date().toISOString(),
    rpc: RPC_URL,
    registry,
    slot: EIP1967_BEACON_SLOT,
    checked: results.length,
    proven: results.filter((row) => row.proven).length,
    mismatched: mismatched.map((row) => row.address),
    unread: unread.map((row) => row.address),
    results,
  };
  if (!options.symbols && !options.limit) {
    await writeFile(new URL("verify.json", DATA), `${JSON.stringify(summary, null, 2)}\n`);
  }
  log(`proven ${summary.proven}/${summary.checked}, mismatched ${mismatched.length}, unread ${unread.length}`);
  process.exit(mismatched.length > 0 ? 1 : 0);
}

// Only the command runs main(); test/ imports parseArgs without starting a pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(function fail(error) {
    log(`verify failed: ${error.stack ?? error}`);
    process.exit(1);
  });
}
