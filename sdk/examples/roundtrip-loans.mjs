/**
 * Live Preprod loan round trip: the savings credit book, never run on a real
 * network on any hash. This is the code that moves OTHER members' money, so it
 * is the highest-value thing to prove live.
 *
 * Two borrowers, two endings:
 *   USER1 borrows against their shares, repays partially, then closes.
 *   USER2 borrows and defaults, marked in arrears, then written off, which
 *   seizes their shares and socialises whatever the seizure does not cover.
 *
 * Multi-party on purpose: a single wallet cannot show that one member's
 * default is absorbed by the other members' shares.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-loans.mjs`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreateFundTxProgram } from "../src/savings/endpoints/createFund.js";
import { unsignedJoinFundTxProgram } from "../src/savings/endpoints/joinFund.js";
import { unsignedDepositTxProgram } from "../src/savings/endpoints/deposit.js";
import { unsignedDisburseLoanTxProgram } from "../src/savings/endpoints/disburseLoan.js";
import { unsignedRepayLoanTxProgram } from "../src/savings/endpoints/repayLoan.js";
import { unsignedMarkArrearsTxProgram } from "../src/savings/endpoints/markArrears.js";
import { unsignedWriteOffLoanTxProgram } from "../src/savings/endpoints/writeOffLoan.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundLoansProgram } from "../src/savings/queries/getFundLoans.js";
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

const settle = () => new Promise((r) => setTimeout(r, 75_000));
const submit = async (tx, label) => {
  const signed = await tx.sign.withWallet().complete();
  const hash = await signed.submit();
  console.log(`${label}: ${hash}`);
  await lucid.awaitTx(hash);
  await settle();
  return hash;
};
const now = () => BigInt(Date.now()) - 60_000n;
const show = async (fundTokenName, label) => {
  const s = await Effect.runPromise(getFundStateProgram(lucid, fundTokenName));
  console.log(
    `  ${label}: shares=${s.fund.shares_total} savings=${s.fund.savings_total}` +
      ` loans_outstanding=${s.fund.loans_outstanding} vault=${s.vaultBalance}`,
  );
  return s;
};

const r = manifest.refScripts.savings;
const [scriptRef] = await lucid.utxosByOutRef([
  { txHash: r.txHash, outputIndex: r.outputIndex },
]);
console.log("savings ref:", r.txHash, "hash", r.scriptHash);

// USER1 creates the fund and is its quorum.
asUser1();
const { tx: createTx, fundTokenName } = await Effect.runPromise(
  unsignedCreateFundTxProgram(lucid, {
    scriptRef,
    title: "Preprod credit fund",
    groupType: GroupType.Asca,
    shareValue: 1_000_000n,
    minSharesPerDeposit: 1n,
    maxSharesPerDeposit: 100n,
    withdrawalPolicy: 0n,
    maxLoanMultiple: 2n,
    // The default is 14 days. Arrears climbs Current → Late → Defaulted, and
    // the second step needs `due + grace` to have passed, so a real grace
    // window would put the write-off two weeks out of reach of this run.
    loanGrace: 0n,
  }),
);
await submit(createTx, "createFund (ASCA, loans enabled)");
console.log("  fundTokenName:", fundTokenName);

const join = async (label) => {
  const { tx, memberTokenSuffix } = await Effect.runPromise(
    unsignedJoinFundTxProgram(lucid, {
      scriptRef,
      fundTokenName,
      consent: true,
    }),
  );
  await submit(tx, `joinFund (${label})`);
  return memberTokenSuffix;
};
const deposit = async (memberTokenSuffix, units, label) => {
  const tx = await Effect.runPromise(
    unsignedDepositTxProgram(lucid, {
      scriptRef,
      fundTokenName,
      memberTokenSuffix,
      fundTag: 0n,
      units,
    }),
  );
  await submit(tx, `deposit (${label}, ${units} shares)`);
};

const m1 = await join("USER1");
await deposit(m1, 10n, "USER1");

asUser2();
const m2 = await join("USER2");
await deposit(m2, 10n, "USER2");
await show(fundTokenName, "both members funded");

// ── Loan A: USER1 borrows, repays partially, then closes ──────────────────
asUser1();
const { tx: loanATx, loanTokenName: loanA } = await Effect.runPromise(
  unsignedDisburseLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: m1,
    principal: 6_000_000n,
    serviceCharge: 600_000n,
    due: now() + 3_600_000n,
    currentTime: now(),
  }),
);
await submit(loanATx, "disburseLoan (USER1, 6 ADA + 0.6 charge)");
console.log("  loanA:", loanA);
await show(fundTokenName, "after disburse A");

const partial = await Effect.runPromise(
  unsignedRepayLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: m1,
    loanTokenName: loanA,
    principal: 2_000_000n,
    charge: 0n,
  }),
);
await submit(partial, "repayLoan (partial, 2 ADA principal)");

const closeLoan = await Effect.runPromise(
  unsignedRepayLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: m1,
    loanTokenName: loanA,
  }),
);
await submit(closeLoan, "repayLoan (close: balance + charge)");
await show(fundTokenName, "after loan A closed");

// ── Loan B: USER2 borrows and defaults ────────────────────────────────────
asUser2();
const { tx: loanBTx, loanTokenName: loanB } = await Effect.runPromise(
  unsignedDisburseLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    memberTokenSuffix: m2,
    principal: 8_000_000n,
    serviceCharge: 800_000n,
    // Deliberately short: arrears needs the due date to have passed.
    due: now() + 180_000n,
    currentTime: now(),
  }),
);
await submit(loanBTx, "disburseLoan (USER2, 8 ADA, defaults)");
console.log("  loanB:", loanB);

const loans = await Effect.runPromise(
  getFundLoansProgram(lucid, fundTokenName),
);
console.log("  live loans:", loans.length);

// markArrears is permissionless: anyone may advance an overdue loan ONE
// status step. USER1 (not the borrower) drives both, which is the point.
const waitMs = 180_000 + 120_000;
console.log(`waiting ${waitMs / 1000}s for loan B to fall overdue...`);
await new Promise((res) => setTimeout(res, waitMs));

asUser1();
for (const [step, label] of [
  [1, "Current → Late"],
  [2, "Late → Defaulted"],
]) {
  const arrears = await Effect.runPromise(
    unsignedMarkArrearsTxProgram(lucid, {
      scriptRef,
      loanTokenName: loanB,
      currentTime: now(),
    }),
  );
  await submit(arrears, `markArrears step ${step} (${label})`);
}

// The quorum writes it off: seize USER2's shares, socialise the shortfall.
const before = await show(fundTokenName, "before write-off");
const writeOff = await Effect.runPromise(
  unsignedWriteOffLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    loanTokenName: loanB,
  }),
);
await submit(writeOff, "writeOffLoan (seize shares, socialise the rest)");
const after = await show(fundTokenName, "after write-off");

if (after.fund.loans_outstanding !== 0n) {
  throw new Error(`loans still outstanding: ${after.fund.loans_outstanding}`);
}
if (after.fund.shares_total >= before.fund.shares_total) {
  throw new Error("write-off did not seize the defaulter's shares");
}
console.log(
  `\nLOAN ROUND TRIP COMPLETE: shares ${before.fund.shares_total} → ${after.fund.shares_total}` +
    ` (defaulter's stake seized), loans_outstanding 0.`,
);
