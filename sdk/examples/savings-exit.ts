/**
 * Savings Exit Example
 *
 * The active member exits the fund: the account reference UTxO is spent and
 * both CIP-68 tokens burn. Requires a zeroed share balance (claim or
 * withdraw first). Works with or without a live fund anchor — accounts are
 * never stuck after fund closure. The account's min-ADA returns to the
 * member.
 *
 * Wallet selection: ACTIVE_WALLET (default USER1).
 *
 * Usage:
 *   pnpm run savings-exit
 */

import { exitFund } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { clearState, loadState, savingsSuffixKey } from "./state.js";

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
  const memberTokenSuffix = state[savingsSuffixKey(wallet)];
  if (!memberTokenSuffix) {
    throw new Error(`No savings member suffix for ${wallet} in state.json.`);
  }

  const tx = await exitFund(lucid, { memberTokenSuffix }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  clearState([savingsSuffixKey(wallet)]);
  console.log("Account pair burned — exit complete.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
