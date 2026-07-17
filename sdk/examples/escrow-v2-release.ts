/**
 * Release Milestone (V2) Example
 *
 * The verifier approves the CURRENT milestone: the tranche pays out to the
 * beneficiary (split with any co-beneficiaries by their basis points). The
 * final release burns the state token and returns the min-ADA buffer to the
 * funder — enforced on-chain in v2.
 *
 * Wallet selection: ACTIVE_WALLET must be the verifier (default USER1).
 *
 * Env:
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN pnpm run escrow-v2-release
 */

import { releaseMilestone } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  console.log("Building release transaction (verifier signs)...");
  const tx = await releaseMilestone(lucid, { stateTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Milestone released.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
