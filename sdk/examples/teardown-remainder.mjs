/**
 * Preprod teardown, phase 5: the leftovers the first sweep missed.
 *
 * Two escrow v1 escrows whose funder and beneficiary are both ADMIN at
 * accountIndex 1, both past expiry, so the funder can reclaim.
 *
 * Nine ROSCA member accounts held by our wallets that are bound to no live
 * group's treasury, so deleteAccount burns the CIP-68 pair and returns the
 * reference UTxO's min-ADA.
 *
 * The other two escrow v1 escrows (302 and 1,002 ADA) belong to external
 * wallets and do not expire until November 2026 and January 2027. They are not
 * touched here and cannot be.
 *
 * Usage: from sdk/, `npx tsx examples/teardown-remainder.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { buildProtocol } from "../src/core/validators/constants.js";
import { unsignedReclaimEscrowTxProgram } from "../src/escrow/endpoints/reclaimEscrow.js";
import { unsignedDeleteAccountTxProgram } from "../src/endpoints/deleteAccount.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v.join("=").trim().replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
const use = (name, accountIndex = 0) =>
  lucid.selectWallet.fromSeed(env[`${name}_SEED`], { accountIndex });

const settle = (s = 45) => new Promise((r) => setTimeout(r, s * 1000));
const protocol = buildProtocol(manifest.settingsPolicy);

const run = async (label, program) => {
  const built = await Effect.runPromise(Effect.either(program));
  if (built._tag !== "Right") {
    console.log(`  ${label}: BUILD FAILED ${String(built.left).slice(0, 220)}`);
    return false;
  }
  try {
    const signed = await built.right.sign.withWallet().complete();
    const hash = await signed.submit();
    console.log(`  ${label}: ${hash}`);
    await lucid.awaitTx(hash);
    await settle();
    return true;
  } catch (e) {
    console.log(`  ${label}: SUBMIT FAILED ${String(e).slice(0, 220)}`);
    return false;
  }
};

console.log("=== escrow v1, expired, funder = ADMIN#1");
use("ADMIN", 1);
for (const name of [
  "b719f09e9b59bf3895fff65ba5fc045059ca51b8b02b366a08ea1e1602bbc997",
  "9b206cdc529d32d01282f1be6362cbdec49e839637d3dd0215240d3aa561dec9",
]) {
  await run(
    `reclaimEscrow ${name.slice(0, 10)}…`,
    unsignedReclaimEscrowTxProgram(lucid, {
      stateTokenName: name,
      currentTime: BigInt(Date.now()) - 120_000n,
    }),
  );
}

// Account tokens in our wallets that no live treasury references.
const ACCOUNTS = [
  { suffix: "18b47e8ea5bf2a9b5020da3e6f8431a68054289e728d532b4c1b8b78", wallet: "ADMIN" },
  { suffix: "1053643ca0010f8b45220eb77a2cc3f662b1a0aa96e78ee6c2415cdd", wallet: "ADMIN" },
  { suffix: "924fe76f89d13594b0d671d92c51dda4b74b56c85a716220eb566096", wallet: "ADMIN" },
  { suffix: "34bca0e737ddea7292a31a95aa042b19910f4afc64aab1c3e8a1766b", wallet: "ADMIN" },
  { suffix: "f089aa9903fe757604e51e92ca50655336543fb6656524b2f3b98363", wallet: "ADMIN" },
  { suffix: "7485f7a3db9fd26a1f520470e3d04339f029e4cb86a98f144bd6ff77", wallet: "ADMIN" },
  { suffix: "ad864b5741b2775a94ccba936602eff06de5b20d127e50257e7d3c7f", wallet: "USER2" },
  { suffix: "9015ab0f56c402d5293d57bbec74fb1478e6906c6f0b0bdc01762250", wallet: "USER2" },
  { suffix: "86b20a8138f8e47e46bd3f52b9cf63029194c5677726c7697d9d3456", wallet: "USER2" },
];

console.log("\n=== ROSCA member accounts bound to no live group");
for (const a of ACCOUNTS) {
  use(a.wallet);
  await run(
    `deleteAccount ${a.wallet} ${a.suffix.slice(0, 10)}…`,
    unsignedDeleteAccountTxProgram(protocol, lucid, {
      accountTokenSuffix: a.suffix,
    }),
  );
}
