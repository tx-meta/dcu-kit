/**
 * Savings Close Cycle Example
 *
 * The quorum freezes the share-out snapshot: everything in the vault except
 * the social fund (and, for ADA funds, the anchor's 2 ADA protocol buffer)
 * becomes the distributable pot — EXACTLY, on-chain. Freezing moves no
 * value; members then claim independently with savings-claim.
 *
 * Wallet selection: ACTIVE_WALLET must satisfy the quorum credential.
 *
 * Usage:
 *   pnpm run savings-close-cycle
 */

import { closeCycle } from "@tx-meta/dcu-kit/savings";
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

  const state = loadState();
  if (!state.savingsFundTokenName) {
    throw new Error("Run savings-create first.");
  }

  const tx = await closeCycle(lucid, {
    fundTokenName: state.savingsFundTokenName,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Cycle closed — members claim with savings-claim.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
