/**
 * Raise Dispute (V2) Example
 *
 * Funder or beneficiary freezes the CURRENT milestone's fund paths (release /
 * timeout / reclaim) for the dispute window, handing the decision to the
 * escrow's arbiter. The cure window extends by the same length, so a
 * last-moment dispute cannot steal the counterparty's window. One dispute per
 * milestone.
 *
 * Wallet selection: ACTIVE_WALLET must be the raising party (default USER1).
 *
 * Env:
 *   RAISED_BY=funder|beneficiary   default funder
 *   ESCROW_V2_STATE_TOKEN=...      overrides state.json
 *
 * Usage:
 *   pnpm run escrow-v2-dispute
 */

import { raiseDispute } from "@tx-meta/dcu-kit/escrow/v2";
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

  const raisedBy = (process.env.RAISED_BY ?? "funder") as
    | "funder"
    | "beneficiary";

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  console.log(`Raising a dispute as the ${raisedBy}...`);
  const tx = await raiseDispute(lucid, { stateTokenName, raisedBy }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(
    "Dispute raised — fund paths frozen for the dispute window; the arbiter can resolve.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
