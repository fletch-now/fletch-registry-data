// Pure shaping: API rows in, files out. Nothing here touches the network or
// the filesystem, so every rule (which assets make the token list, how a long
// name is shortened, when the list version bumps, when paging stops) is
// covered by test/ without a live API.

import { getAddress } from "viem";

export const TOKEN_LIST_NAME = "Fletch Stock Tokens";
export const TOKEN_LIST_KEYWORDS = ["robinhood chain", "stock tokens", "fletch"];
export const TOKEN_LIST_TAGS = {
  stock: {
    name: "Stock Token",
    description: "Issuer deployed Stock Token on Robinhood Chain whose EIP1967 beacon slot points at the AccessControlsRegistry.",
  },
};

// The Uniswap schema caps a token name at 60 characters. Three listed names
// only pass that cap once the issuer's suffix is removed, and the suffix
// carries no identity the symbol does not.
export const NAME_SUFFIX = " • Robinhood Token";
const NAME_MAX = 60;
// An extension string may be at most 42 characters, the length of an address.
const EXTENSION_MAX = 42;

export function isCanonicalStockToken(asset) {
  return asset.assetType === "stock_token" && asset.trust?.level === "confirmed" && asset.state?.canonical === true;
}

export function tokenListName(name) {
  if (name.length <= NAME_MAX) {
    return name;
  }
  const trimmed = name.endsWith(NAME_SUFFIX) ? name.slice(0, -NAME_SUFFIX.length) : name;
  return trimmed.length <= NAME_MAX ? trimmed : trimmed.slice(0, NAME_MAX).trimEnd();
}

// Collation is pinned so a snapshot taken on a laptop in another locale sorts
// the files the same way the runner does; a reordering is not a change.
const COLLATION = "en";

export function sortAssets(assets) {
  return [...assets].sort(function bySymbolThenAddress(a, b) {
    return a.symbol.localeCompare(b.symbol, COLLATION) || a.address.localeCompare(b.address, COLLATION);
  });
}

// Robinhood's listing payload (`raw`) and the ISIN are reproduced from
// Robinhood's API and are not Fletch's to redistribute; everything else on the
// row is read from the chain, derived by Fletch, or a single attributed field.
// Robinhood's own listing payload is not redistributed: the raw record, the
// ISIN, the logo URL and the quote are dropped, leaving the identifiers and
// the on-chain facts that anyone can read from the chain.
export function withoutListingPayload(asset) {
  const { raw, isin, logoUrl, ...rest } = asset;
  if (rest.state && typeof rest.state === "object" && "quote" in rest.state) {
    const { quote, ...state } = rest.state;
    return { ...rest, state };
  }
  return rest;
}

function extensionsFor(asset) {
  const extensions = {};
  const registryUrl = `https://fletch.now/registry/${asset.symbol}`;
  if (registryUrl.length <= EXTENSION_MAX) {
    extensions.registry = registryUrl;
  }
  if (asset.state?.beacon) {
    extensions.beacon = asset.state.beacon;
  }
  return extensions;
}

function tokenInfo(asset) {
  const token = {
    chainId: asset.chainId,
    address: getAddress(asset.address),
    name: tokenListName(asset.onchainName ?? asset.name),
    symbol: asset.symbol,
    decimals: asset.decimals,
    tags: ["stock"],
  };
  if (asset.logoUrl) {
    token.logoURI = asset.logoUrl;
  }
  token.extensions = extensionsFor(asset);
  return token;
}

function tokenKey(token) {
  return `${token.chainId}_${token.address.toLowerCase()}`;
}

// Uniswap's rule: major when a token leaves, minor when one arrives, patch
// when a token's details change; null when nothing did, so the file is left
// alone and its timestamp keeps meaning "when this version was made".
export function nextVersion(previous, tokens) {
  if (!previous) {
    return { major: 1, minor: 0, patch: 0 };
  }
  const before = new Map(previous.tokens.map((token) => [tokenKey(token), token]));
  const after = new Map(tokens.map((token) => [tokenKey(token), token]));
  const removed = [...before.keys()].some((key) => !after.has(key));
  const added = [...after.keys()].some((key) => !before.has(key));
  const changed = [...after].some(([key, token]) => before.has(key) && JSON.stringify(before.get(key)) !== JSON.stringify(token));
  const version = previous.version;
  if (removed) {
    return { major: version.major + 1, minor: 0, patch: 0 };
  }
  if (added) {
    return { major: version.major, minor: version.minor + 1, patch: 0 };
  }
  if (changed) {
    return { major: version.major, minor: version.minor, patch: version.patch + 1 };
  }
  return null;
}

export function buildTokenList(assets, previous, now) {
  const tokens = sortAssets(assets.filter(isCanonicalStockToken)).map(tokenInfo);
  const version = nextVersion(previous, tokens);
  if (version === null) {
    return previous;
  }
  return {
    name: TOKEN_LIST_NAME,
    timestamp: now.toISOString(),
    version,
    keywords: TOKEN_LIST_KEYWORDS,
    tags: TOKEN_LIST_TAGS,
    tokens,
  };
}

export function csvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A leading =, +, -, @, tab or CR makes a spreadsheet evaluate the cell; a
  // quote prefix keeps it text. Plain numbers keep their sign.
  const guarded = typeof value !== "number" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

// One flat row per asset. The nested `state` block is spread into named columns.
export const ASSET_CSV_COLUMNS = [
  ["symbol", (a) => a.symbol],
  ["name", (a) => a.name],
  ["address", (a) => a.address],
  ["assetType", (a) => a.assetType],
  ["decimals", (a) => a.decimals],
  ["status", (a) => a.status],
  ["trustLevel", (a) => a.trust?.level],
  ["canonical", (a) => a.state?.canonical],
  ["beacon", (a) => a.state?.beacon],
  ["implementation", (a) => a.state?.implementation],
  ["multiplier", (a) => a.state?.multiplier],
  ["pendingMultiplier", (a) => a.state?.pendingMultiplier],
  ["multiplierEffectiveAt", (a) => a.state?.multiplierEffectiveAt],
  ["tokenPaused", (a) => a.state?.tokenPaused],
  ["oraclePaused", (a) => a.state?.oraclePaused],
  ["totalSupplyRaw", (a) => a.state?.totalSupplyRaw],
  ["feedAddress", (a) => a.state?.feed?.address],
  ["feedPrice", (a) => a.state?.feed?.price],
  ["feedUpdatedAt", (a) => a.state?.feed?.updatedAt],
  ["feedStale", (a) => a.state?.feed?.stale],
  ["bid", (a) => a.state?.quote?.bid],
  ["ask", (a) => a.state?.quote?.ask],
  ["tradingHalt", (a) => a.state?.quote?.tradingHalt],
  ["priceDivergencePct", (a) => a.state?.priceDivergencePct],
  ["dexVenue", (a) => a.state?.dex?.venue],
  ["dexPriceUsd", (a) => a.state?.dex?.priceUsd],
  ["dexPremiumPct", (a) => a.state?.dex?.premiumPct],
  ["blockscoutHolders", (a) => a.state?.secondSource?.holders],
  ["blockscoutTransfers", (a) => a.state?.secondSource?.transfers],
  ["supplyAgreement", (a) => a.state?.secondSource?.supplyAgreement],
  ["firstSeenAt", (a) => a.firstSeenAt],
  ["verifiedAt", (a) => a.verifiedAt],
  ["stateCheckedAt", (a) => a.state?.checkedAt],
  ["logoUrl", (a) => a.logoUrl],
];

export function assetsCsv(assets) {
  const header = ASSET_CSV_COLUMNS.map(([name]) => name).join(",");
  const rows = sortAssets(assets).map(function toRow(asset) {
    return ASSET_CSV_COLUMNS.map(([, read]) => csvCell(read(asset))).join(",");
  });
  return `${[header, ...rows].join("\n")}\n`;
}

// Identity is what a lookalike is; counts are how many hold it today. Kept
// apart so a diff of the identity file shows arrivals and departures only.
export function splitLookalikes(rows) {
  const sorted = [...rows].sort((a, b) => a.address.localeCompare(b.address, COLLATION));
  const identity = sorted.map(function identityOf(row) {
    return {
      address: row.address,
      symbol: row.symbol,
      name: row.name,
      decimals: row.decimals,
      claims: row.claims,
      kind: row.kind,
      exactName: row.exactName,
      beacon: row.beacon,
      firstSeenAt: row.firstSeenAt,
    };
  });
  const counts = sorted.map(function countsOf(row) {
    return { address: row.address, holders: row.holders, totalSupplyRaw: row.totalSupplyRaw, lastSeenAt: row.lastSeenAt };
  });
  return { identity, counts };
}

// Walks `offset` in steps of `limit` until a short page. A full page that adds
// no new row means the server ignored `offset` (an API older than the paging
// change); the walk stops rather than loop, and `complete` says so.
export async function collectPaged(fetchPage, { limit, key, maxPages = 200 }) {
  const seen = new Map();
  let offset = 0;
  let pages = 0;
  let complete = false;
  while (pages < maxPages) {
    const rows = await fetchPage(offset, limit);
    pages += 1;
    let fresh = 0;
    for (const row of rows) {
      const id = key(row);
      if (!seen.has(id)) {
        seen.set(id, row);
        fresh += 1;
      }
    }
    if (rows.length < limit) {
      complete = true;
      break;
    }
    if (fresh === 0) {
      break;
    }
    offset += limit;
  }
  return { rows: [...seen.values()], pages, complete };
}

export function eventCursor(event) {
  return `${event.observedAt}|${event.id}`;
}

// Follows `nextCursor` oldest-first until a page comes back shorter than
// `limit`. The cursor returned is the one to store: the API's own, or the
// starting one when nothing was new.
export async function collectEvents(fetchPage, startCursor, { limit, maxPages = 400 }) {
  const events = [];
  let cursor = startCursor;
  let pages = 0;
  let complete = false;
  while (pages < maxPages) {
    const page = await fetchPage(cursor, limit);
    pages += 1;
    events.push(...page.events);
    if (page.events.length > 0) {
      cursor = page.nextCursor ?? eventCursor(page.events[page.events.length - 1]);
    }
    if (page.events.length < limit) {
      complete = true;
      break;
    }
  }
  return { events, cursor, pages, complete };
}

// The low 20 bytes of a 32-byte slot, or null for an empty slot.
export function addressFromSlot(value) {
  if (!value || value.length < 42) {
    return null;
  }
  const address = `0x${value.slice(-40)}`.toLowerCase();
  return address === "0x0000000000000000000000000000000000000000" ? null : address;
}
