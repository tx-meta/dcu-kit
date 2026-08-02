/**
 * Live Preprod savings tail: the half of the ASCA/VSLA lifecycle that had never
 * run on a real network. Create a savings fund, join TWO members holding
 * different share counts, close the cycle, then have each member CLAIM their
 * own share-out before the fund is dissolved.
 *
 * The claim is the point. Share-out is member-pulled, not quorum-pushed: no
 * authority can move a member's savings, so the only way the pot leaves the
 * vault is each member spending their own account against it. USER2 is the
 * proof that carries the weight — they neither created the fund nor hold any
 * quorum authority over it, and still cannot be stopped from taking their 4/12.
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
const asUser1 = () => lucid.selectWallet.fromSeed(env.USER1_SEED);
const asUser2 = () => lucid.selectWallet.fromSeed(env.USER2_SEED);
asUser1();
const settle = () => new Promise((r) => setTimeout(r, 75_000));
/** A dropped socket is transient; a validator rejection is not. Retry both a
 *  few times but let the last error surface unchanged. */
const retry = async (label, fn, attempts = 4) => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = /fetch failed|socket|ECONN|timeout|502|503|504/i.test(
        String(e?.message ?? e),
      );
      if (!transient || i === attempts) throw e;
      console.log(`  (${label} attempt ${i} failed, retrying: ${e.message})`);
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
};
const run = (label, program) => retry(label, () => Effect.runPromise(program));
const submit = async (tx, label) => {
  const hash = await retry(label, async () => {
    const signed = await tx.sign.withWallet().complete();
    return signed.submit();
  });
  console.log(`${label}: ${hash}`);
  await retry(`${label} confirm`, () => lucid.awaitTx(hash));
  await settle();
  return hash;
};
const show = async (fundTokenName, label) => {
  const s = await run(
    "getFundState",
    getFundStateProgram(lucid, fundTokenName),
  );
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

const { tx: createTx, fundTokenName } = await run(
  "createFund",
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

const { tx: joinTx, memberTokenSuffix } = await run(
  "joinFund",
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(joinTx, "joinFund (USER1)");

const depositTx = await run(
  "deposit",
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
    fundTag: 0n, // buy shares
    units: 8n,
  }),
);
await submit(depositTx, "deposit (USER1, 8 shares)");

// A SECOND member, holding a different share count. Share-out is member-pulled,
// so the claim that matters is the one made by someone who did not create the
// fund and holds no quorum authority over it.
asUser2();
const { tx: join2Tx, memberTokenSuffix: member2 } = await run(
  "joinFund USER2",
  unsignedJoinFundTxProgram(lucid, { scriptRef, fundTokenName, consent: true }),
);
await submit(join2Tx, "joinFund (USER2)");

const deposit2Tx = await run(
  "deposit USER2",
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: member2,
    fundTag: 0n,
    units: 4n,
  }),
);
await submit(deposit2Tx, "deposit (USER2, 4 shares)");
const deposited = await show(fundTokenName, "after both deposits");
if (deposited.fund.shares_total !== 12n) {
  throw new Error(
    `expected 12 shares total, got ${deposited.fund.shares_total}`,
  );
}

asUser1();

const closeCycleTx = await run(
  "closeCycle",
  unsignedCloseCycleTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeCycleTx, "closeCycle");
await show(fundTokenName, "after closeCycle");

// The tail: each member pulls their OWN share of the pot. No authority can move
// another member's savings, so the pot only leaves the vault one claim at a time.
const claimTx = await run(
  "claimShareOut",
  unsignedClaimShareOutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix,
  }),
);
await submit(claimTx, "claimShareOut (USER1, 8/12)");
const mid = await show(fundTokenName, "after USER1 claim");
if (mid.fund.status.SharingOut?.shares_remaining !== 4n) {
  throw new Error(
    `expected USER2's 4 shares outstanding, got ${mid.fund.status.SharingOut?.shares_remaining}`,
  );
}

asUser2();
const claim2Tx = await run(
  "claimShareOut USER2",
  unsignedClaimShareOutTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: member2,
  }),
);
await submit(claim2Tx, "claimShareOut (USER2, 4/12 — non-creator)");
asUser1();
const after = await show(fundTokenName, "after both claims");
if (after.fund.status.SharingOut?.shares_remaining !== 0n) {
  throw new Error(
    `shares still unclaimed: ${after.fund.status.SharingOut?.shares_remaining}`,
  );
}

const closeFundTx = await run(
  "closeFund",
  unsignedCloseFundTxProgram(lucid, { scriptRef, fundTokenName }),
);
await submit(closeFundTx, "closeFund");
console.log(
  "\nSAVINGS TAIL COMPLETE — two members, both share-outs claimed, fund dissolved.",
);
