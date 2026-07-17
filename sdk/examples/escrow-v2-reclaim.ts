/**
 * Reclaim Escrow (V2) Example
 *
 * The funder takes back the remaining balance of an OVERDUE escrow created
 * with timeoutPolicy=RefundToFunder — the current milestone's cure window
 * (deadline + grace, dispute-extended) has passed with no release. Burns the
 * state token.
 *
 * Wallet selection: ACTIVE_WALLET must be the funder (default USER1).
 *
 * Env:
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   pnpm run escrow-v2-reclaim
 */

import { reclaimEscrow } from "@tx-meta/dcu-kit/escrow/v2";
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

  console.log("Building reclaim transaction (funder signs)...");
  const tx = await reclaimEscrow(lucid, { stateTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Escrow reclaimed — remaining balance returned to the funder.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
