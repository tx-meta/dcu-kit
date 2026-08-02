/**
 * Live Preprod fundraiser round trip, multi-party.
 *
 * Two wallets are MANDATORY, not a stylistic choice: `createEscrow` refuses an
 * escrow whose verifier is also the beneficiary ("a sole release signer must
 * never be the payee"), so this path cannot be proven with one key.
 *   USER1 = contributor + pool quorum + release verifier
 *   USER2 = beneficiary
 *
 * It also exercises BOTH allocation shapes. A `PerMilestone` escrow seeded by
 * `newEscrow` locks only the min-ADA buffer: tranches are funded by later
 * allocations. So allocating once and releasing crashes the validator on an
 * unfunded tranche; the second allocation into `existingStateTokenName` is
 * what makes the release valid.
 *
 * Resume after a partial run:
 *   npx tsx examples/roundtrip-fundraiser.mjs [poolTokenName] [stateTokenName]
 */
import { readFileSync } from "node:fs";
import { Lucid, Blockfrost } from "@lucid-evolution/lucid";
import { Effect } from "effect";
import { unsignedCreatePoolTxProgram } from "../src/escrow/v2/endpoints/createPool.js";
import { unsignedDepositToPoolTxProgram } from "../src/escrow/v2/endpoints/depositToPool.js";
import { unsignedAllocateToEscrowTxProgram } from "../src/escrow/v2/endpoints/allocateToEscrow.js";
import { unsignedReleaseMilestoneV2TxProgram } from "../src/escrow/v2/endpoints/releaseMilestone.js";
import { unsignedExitDepositTxProgram } from "../src/escrow/v2/endpoints/exitDeposit.js";
import { unsignedUpdatePoolTxProgram } from "../src/escrow/v2/endpoints/updatePool.js";
import { unsignedClosePoolTxProgram } from "../src/escrow/v2/endpoints/closePool.js";
import { getEscrowStateProgram } from "../src/escrow/v2/queries/getEscrowState.js";
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
asUser2();
const beneficiary = await lucid.wallet().address();
asUser1();
const address = await lucid.wallet().address();

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

const e = manifest.refScripts.escrowV2;
const [escrowRef] = await lucid.utxosByOutRef([
  { txHash: e.txHash, outputIndex: e.outputIndex },
]);
// Pool and project scripts still ride inline; only escrow needs the reference.
// The allocation tx witnesses BOTH and still fits under the 16 KB ceiling.
const scriptRefs = { escrow: escrowRef };

let poolTokenName = process.argv[2];
let stateTokenName = process.argv[3];

if (!poolTokenName) {
  const created = await Effect.runPromise(
    unsignedCreatePoolTxProgram(lucid, {
      scriptRefs,
      title: "Preprod fundraiser pool",
    }),
  );
  poolTokenName = created.poolTokenName;
  await submit(created.tx, "createPool");
  console.log("  poolTokenName:", poolTokenName);

  const dep = await Effect.runPromise(
    unsignedDepositToPoolTxProgram(lucid, {
      poolTokenName,
      amount: 25_000_000n,
    }),
  );
  await submit(dep, "depositToPool (25 ADA)");
} else {
  console.log("resuming pool:", poolTokenName);
}

if (!stateTokenName) {
  const alloc = await Effect.runPromise(
    unsignedAllocateToEscrowTxProgram(lucid, {
      poolTokenName,
      scriptRefs,
      currentTime: now(),
      newEscrow: {
        scriptRefs,
        title: "Preprod fundraiser milestone",
        beneficiaryAddress: beneficiary,
        verifier: address,
        fundingMode: "PerMilestone",
        timeoutPolicy: "RefundToFunder",
        milestones: [{ amount: 10_000_000n, deadline: now() + 3_600_000n }],
      },
    }),
  );
  stateTokenName = alloc.stateTokenName;
  await submit(alloc.tx, "allocateToEscrow (seed a PerMilestone escrow)");
  console.log("  stateTokenName:", stateTokenName);
} else {
  console.log("resuming escrow:", stateTokenName);
}

// The seeding allocation locked only min-ADA. This one funds the tranche.
const before = await Effect.runPromise(
  getEscrowStateProgram(lucid, { stateTokenName, currentTime: now() }),
);
if (!before.nextTrancheFunded) {
  const topUp = await Effect.runPromise(
    unsignedAllocateToEscrowTxProgram(lucid, {
      poolTokenName,
      scriptRefs,
      currentTime: now(),
      existingStateTokenName: stateTokenName,
    }),
  );
  await submit(topUp.tx, "allocateToEscrow (fund the tranche)");
}
const funded = await Effect.runPromise(
  getEscrowStateProgram(lucid, { stateTokenName, currentTime: now() }),
);
console.log(
  "  lockedBalance:",
  funded.lockedBalance,
  "nextTrancheFunded:",
  funded.nextTrancheFunded,
);
if (!funded.nextTrancheFunded) throw new Error("tranche still unfunded");

// A second deposit, so there is something left to exit AFTER the pool closes.
const dep2 = await Effect.runPromise(
  unsignedDepositToPoolTxProgram(lucid, {
    poolTokenName,
    amount: 12_000_000n,
  }),
);
await submit(dep2, "depositToPool (12 ADA, for the post-close exit)");

// USER1 is the verifier; USER2 is paid. Sole milestone → final → state burns.
const release = await Effect.runPromise(
  unsignedReleaseMilestoneV2TxProgram(lucid, {
    scriptRefs,
    stateTokenName,
    currentTime: now(),
  }),
);
await submit(release, "releaseMilestone (10 ADA → USER2)");

const closeTx = await Effect.runPromise(
  unsignedUpdatePoolTxProgram(lucid, {
    scriptRefs,
    poolTokenName,
    status: "Closed",
  }),
);
await submit(closeTx, "updatePool (Closed)");

const burnTx = await Effect.runPromise(
  unsignedClosePoolTxProgram(lucid, { scriptRefs, poolTokenName }),
);
await submit(burnTx, "closePool");

// [spec 3.5 ClosePool]: deposits are individually owned and outlive the anchor.
const exitTx = await Effect.runPromise(
  unsignedExitDepositTxProgram(lucid, {
    scriptRefs,
    poolTokenName,
    currentTime: now(),
  }),
);
await submit(exitTx, "exitDeposit (after the anchor burned)");
console.log(
  "\nFUNDRAISER ROUND TRIP COMPLETE: pool closed, deposit recovered.",
);
