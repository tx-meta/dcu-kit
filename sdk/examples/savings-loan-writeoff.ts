/**
 * Savings Loan Write-Off Example
 *
 * The quorum closes a Defaulted loan: the borrower's shares are seized up
 * to the outstanding amount, the remainder is socialized (it shrinks the
 * next share-out pot), and the record burns — leaving the permanent
 * Defaulted history as the standing signal. No value moves out of the
 * vault.
 *
 * Wallet selection: ACTIVE_WALLET must satisfy the quorum credential.
 *
 * Usage:
 *   pnpm run savings-loan-writeoff
 */

import { writeOffLoan } from "@tx-meta/dcu-kit/savings";
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
  const fundTokenName = state.savingsFundTokenName;
  const loanTokenName = state.savingsLoanTokenName;
  if (!fundTokenName || !loanTokenName) {
    throw new Error("No fund/loan token names in state.json.");
  }

  const tx = await writeOffLoan(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    loanTokenName,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  clearState(["savingsLoanTokenName"]);
  console.log("Loan written off — shares seized, remainder socialized.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
