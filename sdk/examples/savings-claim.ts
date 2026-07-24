/**
 * Savings Claim Share-Out Example
 *
 * The active member claims their proportional share-out:
 * pot * share_units / shares (floor). Claims are independent per member —
 * any order, no crank, no member ceiling.
 *
 * Wallet selection: ACTIVE_WALLET (default USER1) — must hold share units.
 *
 * Usage:
 *   pnpm run savings-claim
 *   ACTIVE_WALLET=USER2 pnpm run savings-claim
 */

import { claimShareOut } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, savingsSuffixKey } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  const wallet = await selectEnvWallet(lucid, "USER1");

  const state = loadState();
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  const fundTokenName = state.savingsFundTokenName;
  const memberTokenSuffix = state[savingsSuffixKey(wallet)];
  if (!fundTokenName || !memberTokenSuffix) {
    throw new Error("Run savings-create and savings-join first.");
  }

  const tx = await claimShareOut(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    memberTokenSuffix,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Share-out claimed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
