/**
 * Savings Loan Arrears Example
 *
 * Advances an overdue loan one status step: Current -> Late past the due
 * date, Late -> Defaulted past due + grace. Permissionless — ANY wallet
 * can crank, so the default record never depends on the quorum. Only the
 * status changes; the borrower can still repay afterwards.
 *
 * Wallet selection: ACTIVE_WALLET (any funded wallet).
 *
 * Usage:
 *   pnpm run savings-loan-arrears
 */

import { markArrears } from "@tx-meta/dcu-kit/savings";
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
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  if (!state.savingsLoanTokenName) {
    throw new Error("No savingsLoanTokenName in state.json.");
  }

  const tx = await markArrears(lucid, {
    scriptRef: savingsRef,
    loanTokenName: state.savingsLoanTokenName,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Loan status advanced one arrears step.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
