import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { buildTokenList, NAME_SUFFIX } from "../scripts/lib.mjs";

const ROOT = new URL("../", import.meta.url);
const schema = JSON.parse(await readFile(new URL("schema/tokenlist.schema.json", ROOT), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

function assertValid(list) {
  const ok = validate(list);
  assert.ok(ok, JSON.stringify(validate.errors, null, 2));
}

test("a list built from a 75-character name validates against the Uniswap schema", function () {
  const list = buildTokenList(
    [
      {
        chainId: 4663,
        address: "0x521cf887e6531c6f667b5bc4d896e5d9bfe8eb2e",
        symbol: "SPCX",
        name: `Space Exploration Technologies Corp. Class A Common Stock${NAME_SUFFIX}`,
        assetType: "stock_token",
        decimals: 18,
        isin: "US0000000000",
        logoUrl: "https://cdn.robinhood.com/x.png",
        trust: { level: "confirmed" },
        state: { canonical: true, beacon: "0xe10b6f6b275de231345c20d14ab812db62151b00" },
      },
    ],
    null,
    new Date(),
  );
  assertValid(list);
});

test("the committed tokenlist.json is schema-valid and only carries chain 4663", { skip: !existsSync(new URL("tokenlist.json", ROOT)) }, async function () {
  const list = JSON.parse(await readFile(new URL("tokenlist.json", ROOT), "utf8"));
  assertValid(list);
  assert.ok(list.tokens.length > 0);
  assert.ok(list.tokens.every((token) => token.chainId === 4663));
  const addresses = list.tokens.map((token) => token.address.toLowerCase());
  assert.equal(new Set(addresses).size, addresses.length);
});
