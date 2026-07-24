/**
 * Close Project Example
 *
 * Burns the Project anchor (owner-authorized) and recovers its min-ADA.
 * Escrows citing the project keep working — the id is opaque and never
 * dereferenced on-chain. Prefer `STATUS=Closed pnpm run project-update` when
 * the record should stay visible.
 *
 * Wallet selection: ACTIVE_WALLET must be the owner (default USER1).
 *
 * Env:
 *   PROJECT_TOKEN=...   overrides state.json
 *
 * Usage:
 *   pnpm run project-close
 */

import { closeProject } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, clearState } from "./state.js";
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

  const projectTokenName = requireToken(
    "PROJECT_TOKEN",
    loadState().projectTokenName,
    "run project-create first.",
  );

  console.log("Burning the project anchor...");
  const tx = await closeProject(lucid, { projectTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  clearState(["projectTokenName"]);
  console.log("Project anchor burned; min-ADA recovered.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
