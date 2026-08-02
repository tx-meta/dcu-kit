/**
 * Live Preprod savings tail: the half of the ASCA/VSLA lifecycle that had never
 * run on a real network. Create a savings fund, join, buy shares, close the
 * cycle, then have the member CLAIM their share-out and dissolve the fund.
 *
 * The claim is the point. Share-out is member-pulled, not quorum-pushed: no
 * authority can move a member's savings, so the only way the pot leaves the
 * vault is each member spending their own account against it.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-savings-tail.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedCloseCycleTxProgram } from "../src/savings/endpoints/closeCycle.js";
import { unsignedClaimShareOutTxProgram } from "../src/savings/endpoints/claimShareOut.js";
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
const show = async (fundTokenName, label) => {
  const s = await Effect.runPromise(getFundStateProgram(lucid, fundTokenName));
  console.log(
    `  ${label}: phase=${s.phase} shares_total=${s.fund.shares_total}` +
      ` vaultBalance=${s.vaultBalance}`,
  );
  return s;
};

const r = manifest.refScripts.savings;
const [scriptRef] = await lucid.utxosByOutRef([
  { txHash: r.txHash, outputIndex: r.outputIndex },
]);

const { tx: createTx, fundTokenName } = await Effect.runPromise(
  unsignedCreateFundTxProgram(lucid, {
    scriptRef,
    title: "Preprod savings tail",
    groupType: GroupType.Vsla,
    shareValue: 1_000_000n,
    minSharesPerDeposit: 1n,
    maxSharesPerDeposit: 100n,
    withdrawalPolicy: 0n,
    maxLoanMultiple: 0n,
  }),
);
await submit(createTx, "createFund (VSLA)");
console.log("  fundTokenName:", fundTokenName);

const { tx: joinTx, memberTokenSuffix } = await Effect.runPromise(
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(joinTx, "joinFund");

const depositTx = await Effect.runPromise(
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
    fundTag: 0n, // buy shares
    units: 8n,
  }),
);
await submit(depositTx, "deposit (8 shares)");
await show(fundTokenName, "after deposit");

const closeCycleTx = await Effect.runPromise(
  unsignedCloseCycleTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeCycleTx, "closeCycle");
await show(fundTokenName, "after closeCycle");

// The tail: the member pulls their own share of the pot.
const claimTx = await Effect.runPromise(
  unsignedClaimShareOutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
  }),
);
await submit(claimTx, "claimShareOut");
const after = await show(fundTokenName, "after claim");
if (after.fund.status.SharingOut?.shares_remaining !== 0n) {
  throw new Error(
    `shares still unclaimed: ${after.fund.status.SharingOut?.shares_remaining}`,
  );
}

const closeFundTx = await Effect.runPromise(
  unsignedCloseFundTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeFundTx, "closeFund");
console.log("\nSAVINGS TAIL COMPLETE — share-out claimed, fund dissolved.");
