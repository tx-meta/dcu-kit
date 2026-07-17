/**
 * Amend Milestones (V2) Example
 *
 * Funder and beneficiary co-sign a new schedule for the UNRELEASED part of the
 * escrow — real projects delay. Released milestones are immutable; an Upfront
 * escrow stays fully funded through the amendment (a larger schedule tops up
 * from the funder's wallet in the same tx, a smaller one refunds the excess).
 *
 * Wallet selection: ACTIVE_WALLET is the funder (default USER1); the
 * beneficiary co-signs via COSIGNER.
 *
 * Env:
 *   COSIGNER=USER2                       beneficiary wallet name (required)
 *   NEW_MILESTONES="4000000:+1h"         the new UNRELEASED tail (required)
 *   TITLE="..."                          optionally retitle
 *   ESCROW_V2_STATE_TOKEN=...            overrides state.json
 *
 * Usage:
 *   COSIGNER=USER2 NEW_MILESTONES="4000000:+1h" pnpm run escrow-v2-amend
 */

import { Effect } from "effect";
import {
  amendMilestones,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import {
  envWalletPaymentKey,
  parseMilestones,
  requireToken,
} from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const cosigner = process.env.COSIGNER;
  const newTail = process.env.NEW_MILESTONES;
  if (!cosigner || !newTail)
    throw new Error(
      "COSIGNER and NEW_MILESTONES are required — amendment is mutual consent.",
    );

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  // The released prefix is immutable — rebuild the FULL schedule as
  // (released prefix as-is) + (the agreed new tail).
  const s = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  const releasedPrefix = s.milestones
    .filter((m) => m.released)
    .map((m) => ({ amount: m.amount, deadline: m.deadline }));
  const milestones = [...releasedPrefix, ...parseMilestones(newTail)];

  console.log(
    `Amending: ${releasedPrefix.length} released milestone(s) kept, ` +
      `new tail of ${milestones.length - releasedPrefix.length}.`,
  );

  const tx = await amendMilestones(lucid, {
    stateTokenName,
    milestones,
    ...(process.env.TITLE ? { title: process.env.TITLE } : {}),
  }).unsafeRun();

  console.log("Collecting both signatures...");
  const signed = await tx.sign
    .withWallet()
    .sign.withPrivateKey(envWalletPaymentKey(cosigner))
    .complete();

  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Milestones amended by mutual consent.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
