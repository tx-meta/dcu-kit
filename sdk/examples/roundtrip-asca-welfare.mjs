/**
 * Live Preprod: the three money-moving savings endpoints that had no valid
 * proof on the post-freeze hash.
 *
 * `withdrawSavings`, `exitFund` and `socialPayout` are all paths by which member
 * money leaves a vault, and each was either never run on a real network or last
 * run before the charter freeze changed the savings hash. Kyama calls all three.
 *
 * Part A is an ASCA fund, which matters twice over. `withdrawal_policy` 1 means
 * flexible withdrawal, and the charter freeze made that field IMMUTABLE for the
 * life of the fund, so the value chosen at creation is now permanent and both
 * values deserve live proof. Every previous live run used policy 0.
 *
 *   create (ASCA, flexible) -> two members join and deposit
 *     -> USER1 sells shares back mid-cycle (withdrawSavings)
 *     -> USER2 leaves the fund entirely (exitFund)
 *
 * Part B is a Welfare fund, where the pot is not member-attributed at all: the
 * quorum pays a beneficiary out of the common pool (socialPayout). That is the
 * one savings path where money moves on a decision rather than on a claim, so it
 * is the one worth watching most closely.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-asca-welfare.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost, walletFromSeed } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedWithdrawSavingsTxProgram } from "../src/savings/endpoints/withdrawSavings.js";
import { unsignedExitFundTxProgram } from "../src/savings/endpoints/exitFund.js";
import { unsignedSocialPayoutTxProgram } from "../src/savings/endpoints/socialPayout.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { GroupType } from "../src/savings/types.js";
import { savingsPolicyId } from "../src/savings/validators.js";
import { assetNameLabels } from "../src/core/utils/index.js";
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
const user2Address = walletFromSeed(env.USER2_SEED, {
  network: "Preprod",
}).address;

const settle = () => new Promise((r) => setTimeout(r, 75_000));
/** A dropped socket is transient; a validator rejection is not. */
const retry = async (label, fn, attempts = 4) => {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient =
        /fetch failed|socket|ECONN|timeout|502|503|504|OutsideValidityInterval/i.test(
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
      ` savings_total=${s.fund.savings_total} vault=${s.vaultBalance}`,
  );
  return s;
};

const r = manifest.refScripts.savings;
const [scriptRef] = await lucid.utxosByOutRef([
  { txHash: r.txHash, outputIndex: r.outputIndex },
]);

// `--skip-a` jumps straight to Part B when Part A is already proven on chain.
const skipA = process.argv.includes("--skip-a");
if (!skipA) {
  console.log("PART A: ASCA fund with flexible withdrawal (policy 1)\n");

  // `--fund <tokenName>` resumes a fund an earlier run already created, joined
  // and funded. Without it every rerun mints another fund and locks another
  // min-ADA, which is waste when only a later step failed.
  const fundArg = process.argv.indexOf("--fund");
  let fundTokenName, m1, m2;
  if (fundArg !== -1) {
    fundTokenName = process.argv[fundArg + 1];
    console.log("resuming fund:", fundTokenName);
    const existing = await run(
      "getFundMembers",
      getFundMembersProgram(lucid, fundTokenName),
    );
    const heldBy = async (suffix) => {
      const address = await lucid.wallet().address();
      const utxos = await retry("utxosAtWithUnit", () =>
        lucid.utxosAtWithUnit(
          address,
          savingsPolicyId + assetNameLabels.prefix222 + suffix,
        ),
      );
      return utxos.length > 0;
    };
    for (const m of existing) {
      asUser1();
      if (await heldBy(m.memberTokenSuffix)) {
        m1 = m.memberTokenSuffix;
        continue;
      }
      asUser2();
      if (await heldBy(m.memberTokenSuffix)) m2 = m.memberTokenSuffix;
    }
    asUser1();
    if (!m1 || !m2) throw new Error("could not map both members to wallets");
    console.log("  members:", m1.slice(0, 12), m2.slice(0, 12));
  } else {
    const { tx: createTx, fundTokenName: mintedFund } = await run(
      "createFund",
      unsignedCreateFundTxProgram(lucid, {
        scriptRef,
        title: "ASCA flexible fund",
        groupType: GroupType.Asca,
        shareValue: 1_000_000n,
        minSharesPerDeposit: 1n,
        maxSharesPerDeposit: 100n,
        withdrawalPolicy: 1n, // flexible; frozen for the life of the fund
        maxLoanMultiple: 0n,
      }),
    );
    fundTokenName = mintedFund;
    await submit(createTx, "createFund (ASCA, flexible)");
    console.log("  fundTokenName:", fundTokenName);

    const { tx: joinTx, memberTokenSuffix: joined1 } = await run(
      "joinFund",
      unsignedJoinFundTxProgram(lucid, {
        scriptRef,
        fundTokenName,
        consent: true,
      }),
    );
    m1 = joined1;
    await submit(joinTx, "joinFund (USER1)");

    const depositTx = await run(
      "deposit",
      unsignedDepositTxProgram(lucid, {
        scriptRef,
        fundTokenName,
        memberTokenSuffix: m1,
        fundTag: 0n,
        units: 10n,
      }),
    );
    await submit(depositTx, "deposit (USER1, 10 shares)");

    asUser2();
    const { tx: join2Tx, memberTokenSuffix: joined2 } = await run(
      "joinFund USER2",
      unsignedJoinFundTxProgram(lucid, {
        scriptRef,
        fundTokenName,
        consent: true,
      }),
    );
    m2 = joined2;
    await submit(join2Tx, "joinFund (USER2)");

    const deposit2Tx = await run(
      "deposit USER2",
      unsignedDepositTxProgram(lucid, {
        scriptRef,
        fundTokenName,
        memberTokenSuffix: m2,
        fundTag: 0n,
        units: 5n,
      }),
    );
    await submit(deposit2Tx, "deposit (USER2, 5 shares)");
    const funded = await show(fundTokenName, "after both deposits");
    if (funded.fund.shares_total !== 15n) {
      throw new Error(`expected 15 shares, got ${funded.fund.shares_total}`);
    }
  }

  // THE POINT of a flexible fund: a member takes money out mid-cycle, without a
  // share-out and without anyone's permission.
  asUser1();
  const state0 = await show(fundTokenName, "before USER1 withdrawal");
  if (state0.fund.shares_total === 11n) {
    console.log("  USER1 already sold back 4 shares, skipping");
  } else {
    const withdrawTx = await run(
      "withdrawSavings",
      unsignedWithdrawSavingsTxProgram(lucid, {
        scriptRef,
        fundTokenName,
        memberTokenSuffix: m1,
        units: 4n,
      }),
    );
    await submit(withdrawTx, "withdrawSavings (USER1 sells back 4 shares)");
  }
  const afterWithdraw = await show(fundTokenName, "after withdrawal");
  if (afterWithdraw.fund.shares_total !== 11n) {
    throw new Error(
      `expected 11 shares after selling back 4, got ${afterWithdraw.fund.shares_total}`,
    );
  }

  // USER2 leaves entirely. `exitFund` refuses while the account still holds
  // share units (it fails fast with "the account still holds N share units"),
  // which is the right guard: leaving must not silently abandon a stake. So the
  // flexible policy is used to take the whole stake out first, then exit.
  asUser2();
  const drainTx = await run(
    "withdrawSavings USER2",
    unsignedWithdrawSavingsTxProgram(lucid, {
      scriptRef,
      fundTokenName,
      memberTokenSuffix: m2,
      units: 5n,
    }),
  );
  await submit(drainTx, "withdrawSavings (USER2 takes all 5 back)");

  const exitTx = await run(
    "exitFund",
    unsignedExitFundTxProgram(lucid, { scriptRef, memberTokenSuffix: m2 }),
  );
  await submit(exitTx, "exitFund (USER2 leaves)");
  const afterExit = await show(fundTokenName, "after USER2 exits");
  const remaining = await run(
    "getFundMembers",
    getFundMembersProgram(lucid, fundTokenName),
  );
  console.log("  members remaining:", remaining.length);
  if (remaining.length !== 1) {
    throw new Error(`expected 1 member left, got ${remaining.length}`);
  }
  if (afterExit.fund.shares_total !== 6n) {
    throw new Error(
      `expected 6 shares once USER2 withdrew 5 and left, got ${afterExit.fund.shares_total}`,
    );
  }
} else {
  console.log("PART A already proven on chain, skipping to Part B\n");
}

// ── Part B: Welfare, quorum-directed payout ──────────────────────────────────
console.log("PART B: Welfare fund, quorum pays a beneficiary\n");

asUser1();
const welfareArg = process.argv.indexOf("--welfare");
let welfareFund, w1;
if (welfareArg !== -1) {
  welfareFund = process.argv[welfareArg + 1];
  console.log("resuming welfare fund:", welfareFund);
  const wm = await run(
    "getFundMembers welfare",
    getFundMembersProgram(lucid, welfareFund),
  );
  w1 = wm[0]?.memberTokenSuffix;
  if (!w1) throw new Error("no member in the welfare fund");
} else {
  const { tx: welfareTx, fundTokenName: mintedWelfare } = await run(
    "createFund welfare",
    unsignedCreateFundTxProgram(lucid, {
      scriptRef,
      title: "Welfare fund",
      groupType: GroupType.Welfare,
      shareValue: 1_000_000n,
      minSharesPerDeposit: 1n,
      maxSharesPerDeposit: 100n,
      withdrawalPolicy: 0n,
      maxLoanMultiple: 0n,
    }),
  );
  welfareFund = mintedWelfare;
  await submit(welfareTx, "createFund (Welfare)");
  console.log("  welfareFund:", welfareFund);

  const { tx: wJoinTx, memberTokenSuffix: joinedW } = await run(
    "joinFund welfare",
    unsignedJoinFundTxProgram(lucid, {
      scriptRef,
      fundTokenName: welfareFund,
      consent: true,
    }),
  );
  w1 = joinedW;
  await submit(wJoinTx, "joinFund (welfare, USER1)");
}

// fundTag 1 is the SOCIAL fund, a pot distinct from share capital. This is
// what makes socialPayout safe: it can only ever draw from social_total, so a
// quorum cannot reach members' share savings through a welfare payment.
const wDepositTx = await run(
  "deposit welfare",
  unsignedDepositTxProgram(lucid, {
    scriptRef,
    fundTokenName: welfareFund,
    memberTokenSuffix: w1,
    fundTag: 1n,
    amount: 8_000_000n,
  }),
);
await submit(wDepositTx, "deposit (welfare, 8 ADA into the SOCIAL pot)");
const wFunded = await show(welfareFund, "welfare funded");
console.log("  social_total:", wFunded.fund.social_total);
if (wFunded.fund.social_total < 3_000_000n) {
  throw new Error(
    `social pot too small for the payout: ${wFunded.fund.social_total}`,
  );
}

// The quorum pays a beneficiary out of the common pot. Nobody claims this and
// no share is redeemed: the money moves on a decision.
const payoutTx = await run(
  "socialPayout",
  unsignedSocialPayoutTxProgram(lucid, {
    scriptRef,
    fundTokenName: welfareFund,
    amount: 3_000_000n,
    destination: user2Address,
  }),
);
await submit(payoutTx, "socialPayout (3 ADA to USER2)");
const wAfter = await show(welfareFund, "welfare after payout");
if (wFunded.vaultBalance - wAfter.vaultBalance !== 3_000_000n) {
  throw new Error(
    `expected the vault to drop by exactly 3 ADA, got ${wFunded.vaultBalance - wAfter.vaultBalance}`,
  );
}

console.log(
  "\nASCA + WELFARE ROUND TRIP COMPLETE: withdrawSavings, exitFund and" +
    " socialPayout all proven on the post-freeze hash.",
);
