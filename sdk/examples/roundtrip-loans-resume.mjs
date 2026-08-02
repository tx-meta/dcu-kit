/**
 * Resume the live loan round trip from whatever is already on-chain.
 *
 * The first run proved disburse + partial repay and then died on a Blockfrost
 * socket drop, so this rediscovers all its state from the chain rather than
 * carrying it in a file: members come from `getFundMembers`, the open loan from
 * `getFundLoans`, and each member's wallet is identified by who holds the (222)
 * token. Every provider call is retried, because a dropped socket should not
 * cost a whole run again.
 *
 * Usage: from sdk/, `npx tsx examples/roundtrip-loans-resume.mjs <fundTokenName>`
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost, walletFromSeed } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedDisburseLoanTxProgram } from "../src/savings/endpoints/disburseLoan.js";
import { unsignedRepayLoanTxProgram } from "../src/savings/endpoints/repayLoan.js";
import { unsignedMarkArrearsTxProgram } from "../src/savings/endpoints/markArrears.js";
import { unsignedWriteOffLoanTxProgram } from "../src/savings/endpoints/writeOffLoan.js";
import { getFundStateProgram } from "../src/savings/queries/getFundState.js";
import { getFundMembersProgram } from "../src/savings/queries/getFundMembers.js";
import { getFundLoansProgram } from "../src/savings/queries/getFundLoans.js";
import { savingsPolicyId } from "../src/savings/validators.js";
import { assetNameLabels } from "../src/core/utils/index.js";
import manifest from "../src/core/deployments/preprod.json" with { type: "json" };

const fundTokenName = process.argv[2];
if (!fundTokenName) throw new Error("pass the fundTokenName");

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
const settle = () => new Promise((r) => setTimeout(r, 75_000));
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
/** disburseLoan needs BOTH the borrower's and the quorum's signature. When one
 *  wallet is both (as in loan A) a single signature satisfies both roles, which
 *  is exactly why a single-wallet test cannot see this requirement. */
const submitCoSigned = async (tx, label, coSignerSeeds) => {
  const hash = await retry(label, async () => {
    // Chaining sign.withWallet() after switching wallets does NOT add a second
    // witness — the builder resolves the wallet once. Co-signers must be
    // supplied as explicit keys, exactly as the emulator suite does.
    const signed = await coSignerSeeds
      .map((seed) => walletFromSeed(seed, { network: "Preprod" }).paymentKey)
      .reduce((b, key) => b.sign.withPrivateKey(key), tx.sign.withWallet())
      .complete();
    return signed.submit();
  });
  console.log(`${label}: ${hash}`);
  await retry(`${label} confirm`, () => lucid.awaitTx(hash));
  await settle();
  return hash;
};
const now = () => BigInt(Date.now()) - 60_000n;
const show = async (label) => {
  const s = await run(
    "getFundState",
    getFundStateProgram(lucid, fundTokenName),
  );
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

// Rediscover which member suffix belongs to which wallet by who holds the (222).
const members = await run(
  "getFundMembers",
  getFundMembersProgram(lucid, fundTokenName),
);
const owns = async (suffix) => {
  const unit = savingsPolicyId + assetNameLabels.prefix222 + suffix;
  // wallet().address() is async — passing the Promise makes every lookup miss.
  const address = await lucid.wallet().address();
  const utxos = await retry("utxosAtWithUnit", () =>
    lucid.utxosAtWithUnit(address, unit),
  );
  return utxos.length > 0;
};
let m1, m2;
for (const m of members) {
  asUser1();
  if (await owns(m.memberTokenSuffix)) {
    m1 = m.memberTokenSuffix;
    continue;
  }
  asUser2();
  if (await owns(m.memberTokenSuffix)) m2 = m.memberTokenSuffix;
}
console.log("members:", members.length, "USER1:", !!m1, "USER2:", !!m2);
if (!m1 || !m2) throw new Error("could not map both members to wallets");

await show("resumed state");

// Close USER1's open loan, if it is still open.
const loans = await run(
  "getFundLoans",
  getFundLoansProgram(lucid, fundTokenName),
);
console.log("open loans:", loans.length);
// borrower_ref is the (100) twin of the borrower's (222) token.
const refNameOf = (suffix) => assetNameLabels.prefix100 + suffix;
const loanA = loans.find((l) => l.loan.borrower_ref === refNameOf(m1));
if (loanA) {
  asUser1();
  const closeTx = await run(
    "repayLoan close",
    unsignedRepayLoanTxProgram(lucid, {
      scriptRef,
      fundTokenName,
      memberTokenSuffix: m1,
      loanTokenName: loanA.loanTokenName,
    }),
  );
  await submit(closeTx, "repayLoan (close: balance + charge)");
  await show("after loan A closed");
} else {
  console.log("  loan A already closed");
}

// USER2 borrows and defaults. Only one active loan per member is allowed, so
// reuse USER2's existing loan when a previous run already disbursed it.
asUser2();
const existingB = loans.find((l) => l.loan.borrower_ref === refNameOf(m2));
let loanB, dueB;
if (existingB) {
  loanB = existingB.loanTokenName;
  dueB = existingB.loan.due;
  console.log("  reusing loan B:", loanB, "due", dueB);
} else {
  // disburseLoan sets validTo = now + 15 min and requires due > validTo, so the
  // soonest a loan can legitimately fall overdue is just past that window.
  dueB = now() + 960_000n;
  const disbursed = await run(
    "disburseLoan B",
    unsignedDisburseLoanTxProgram(lucid, {
      scriptRef,
      fundTokenName,
      memberTokenSuffix: m2,
      principal: 8_000_000n,
      serviceCharge: 800_000n,
      due: dueB,
      currentTime: now(),
    }),
  );
  loanB = disbursed.loanTokenName;
  // Borrower is USER2, quorum is USER1 — two distinct signatures required.
  await submitCoSigned(disbursed.tx, "disburseLoan (USER2, USER1 quorum)", [
    env.USER1_SEED,
  ]);
  console.log("  loanB:", loanB);
}

// markArrears needs the SLOT-floored lower bound strictly past `due`, so leave
// margin beyond the 60s drift buffer rather than racing the boundary.
const waitMs = Number(dueB - BigInt(Date.now())) + 180_000;
if (waitMs > 0) {
  console.log(
    `waiting ${Math.ceil(waitMs / 1000)}s for loan B to fall overdue...`,
  );
  await new Promise((res) => setTimeout(res, waitMs));
}

// markArrears is permissionless: USER1, not the borrower, drives both steps.
asUser1();
for (const [step, label] of [
  [1, "Current → Late"],
  [2, "Late → Defaulted"],
]) {
  const arrears = await run(
    `markArrears ${step}`,
    unsignedMarkArrearsTxProgram(lucid, {
      scriptRef,
      loanTokenName: loanB,
      currentTime: now(),
    }),
  );
  await submit(arrears, `markArrears step ${step} (${label})`);
}

const before = await show("before write-off");
const writeOff = await run(
  "writeOffLoan",
  unsignedWriteOffLoanTxProgram(lucid, {
    scriptRef,
    fundTokenName,
    loanTokenName: loanB,
  }),
);
await submit(writeOff, "writeOffLoan (seize shares, socialise the rest)");
const after = await show("after write-off");

if (after.fund.loans_outstanding !== 0n) {
  throw new Error(`loans still outstanding: ${after.fund.loans_outstanding}`);
}
if (after.fund.shares_total >= before.fund.shares_total) {
  throw new Error("write-off did not seize the defaulter's shares");
}
console.log(
  `\nLOAN ROUND TRIP COMPLETE — shares ${before.fund.shares_total} → ${after.fund.shares_total}` +
    ` (defaulter's stake seized), loans_outstanding 0.`,
);
