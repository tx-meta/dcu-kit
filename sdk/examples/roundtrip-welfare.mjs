/**
 * Live Preprod welfare round trip: create a Welfare fund, join it, contribute to
 * the welfare pot, pay it out, then close the cycle and dissolve the fund.
 *
 * The last two steps are what the hash wave added. A fund that never sells
 * shares had no route to `SharingOut`, so `closeFund` (which requires that
 * status) was unreachable and its min-ADA was locked forever.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-welfare.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedSocialPayoutTxProgram } from "../src/savings/endpoints/socialPayout.js";
import { unsignedCloseCycleTxProgram } from "../src/savings/endpoints/closeCycle.js";
import { unsignedCloseFundTxProgram } from "../src/savings/endpoints/closeFund.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { GroupType } from "../src/savings/types.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const env = {};
for (const line of readFileSync("./examples/.env", "utf8").split("\n")) {
  const t = line.trim();
  if (t && !t.startsWith("#") && t.includes("=")) {
    const [k, ...v] = t.split("=");
    env[k.trim()] = v
      .join("=")
      .trim()
      .replace(/^["']|["']$/g, "");
  }
}
const lucid = await Lucid(
  new Blockfrost(env.BLOCKFROST_URL, env.BLOCKFROST_KEY),
  "Preprod",
);
lucid.selectWallet.fromSeed(env.USER1_SEED);
const settle = () => new Promise((r) => setTimeout(r, 75_000));
const submit = async (tx, label) => {
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`${label}: ${hash}`);
  await lucid.awaitTx(hash);
  await settle();
  return hash;
};

const e = manifest.refScripts.savings;
const [scriptRef] = await lucid.utxosByOutRef([
  { txHash: e.txHash, outputIndex: e.outputIndex },
]);
const address = await lucid.wallet().address();

const { tx: createTx, fundTokenName } = await Effect.runPromise(
  unsignedCreateFundTxProgram(lucid, {
    scriptRef,
    title: "Preprod welfare fund",
    groupType: GroupType.Welfare,
    shareValue: 1_000_000n,
    minSharesPerDeposit: 1n,
    maxSharesPerDeposit: 100n,
    withdrawalPolicy: 0n,
    maxLoanMultiple: 0n,
  }),
);
await submit(createTx, "createFund (Welfare)");
console.log("  fundTokenName:", fundTokenName);

const { tx: joinTx, memberTokenSuffix } = await Effect.runPromise(
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(joinTx, "joinFund");

// Welfare only: every unit goes to the social pot, no shares are bought.
const depTx = await Effect.runPromise(
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
    fundTag: 1n, // the social fund, not shares
    amount: 5_000_000n,
  }),
);
await submit(depTx, "deposit (welfare only)");

const before = await Effect.runPromise(
  getFundStateProgram(lucid, fundTokenName),
);
console.log(
  "  shares_total:",
  before.fund.shares_total,
  "social_total:",
  before.fund.social_total,
);

// The welfare pot must be spent down before the fund can close.
const payTx = await Effect.runPromise(
  unsignedSocialPayoutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    destination: address,
    amount: before.fund.social_total,
  }),
);
await submit(payTx, "socialPayout (drain the welfare pot)");

// The wave's addition: a zero-share fund closes with an empty pot.
const closeCycleTx = await Effect.runPromise(
  unsignedCloseCycleTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeCycleTx, "closeCycle (zero-share)");

const closeFundTx = await Effect.runPromise(
  unsignedCloseFundTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeFundTx, "closeFund");
console.log("\nWELFARE ROUND TRIP COMPLETE: the fund dissolved.");
