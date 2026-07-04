/**
 * Release Milestone Example
 *
 * The verifier releases the next tranche to the beneficiary. Sequential —
 * tranche N must be released before N+1; releases stop at expiry.
 *
 * Wallet selection:
 *   Default (USER1): the verifier (whose key hash the escrow names)
 *
 * Env:
 *   ESCROW_STATE_TOKEN=...  overrides the state.json value from escrow-create
 *
 * Usage:
 *   pnpm run escrow-release
 */

import { Effect } from "effect";
import {
  ReleaseMilestoneConfig,
  releaseMilestone,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const stateTokenName =
    process.env.ESCROW_STATE_TOKEN ?? loadState().escrowStateTokenName;
  if (!stateTokenName)
    throw new Error(
      "No escrowStateTokenName in state.json (and ESCROW_STATE_TOKEN not set). Run escrow-create first.",
    );

  const before = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  if (before.nextTranche === null)
    throw new Error("All milestones already released.");
  console.log(
    `Releasing milestone ${before.releasedCount + 1}/${before.totalMilestones}: ${before.nextTranche} (balance ${before.remainingBalance}).`,
  );

  const config: ReleaseMilestoneConfig = { stateTokenName };

  console.log("Building release transaction...");
  const tx = await releaseMilestone(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  const after = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  console.log(
    `Released. ${after.releasedCount}/${after.totalMilestones} milestones done; balance ${after.remainingBalance}.`,
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
