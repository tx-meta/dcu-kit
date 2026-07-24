/**
 * Savings Close Fund Example
 *
 * After every share has been claimed (shares_remaining = 0), the quorum
 * burns the Fund State NFT and releases the residual value (floor dust plus
 * any unclaimed social fund) to the destination it authorizes.
 *
 * Wallet selection: ACTIVE_WALLET must satisfy the quorum credential.
 *
 * Env:
 *   DESTINATION=addr...   residual destination (default: own wallet)
 *
 * Usage:
 *   pnpm run savings-close-fund
 */

import { closeFund } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { clearState, loadState } from "./state.js";

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
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  if (!state.savingsFundTokenName) {
    throw new Error("No savingsFundTokenName in state.json.");
  }

  const tx = await closeFund(lucid, {
    scriptRef: savingsRef,
    fundTokenName: state.savingsFundTokenName,
    ...(process.env.DESTINATION
      ? { destination: process.env.DESTINATION }
      : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  clearState(["savingsFundTokenName"]);
  console.log("Fund closed — anchor burned, residual released.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
