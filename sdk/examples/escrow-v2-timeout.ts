/**
 * Timeout Release (V2) Example
 *
 * "Silence approves": once a milestone's cure window (deadline + grace)
 * passes with no verifier verdict on an escrow created with
 * timeoutPolicy=ReleaseToBeneficiary, ANYONE can crank the tranche to the
 * beneficiary — no party signature required; the destination is fixed by the
 * datum. The final tranche burns the token and refunds the buffer.
 *
 * Wallet selection: ACTIVE_WALLET pays the fee only (default USER1).
 *
 * Env:
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN pnpm run escrow-v2-timeout
 */

import { timeoutRelease } from "@tx-meta/dcu-kit/escrow/v2";
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

  console.log("Cranking the overdue tranche (no party signature needed)...");
  const tx = await timeoutRelease(lucid, { stateTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Overdue tranche auto-released to the beneficiary.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
