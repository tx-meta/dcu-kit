/**
 * Savings Loan Repay Example
 *
 * Repays the active member's loan. With PRINCIPAL/CHARGE set it is a
 * partial repayment; without them it CLOSES the loan (full outstanding +
 * remaining charge; the Loan State NFT burns). The charge portion is fund
 * income and reaches everyone through the next share-out pot. Repayment
 * stays open in every loan status.
 *
 * Wallet selection: ACTIVE_WALLET is the borrower (default USER1).
 *
 * Env:
 *   PRINCIPAL=5000000   partial: principal portion
 *   CHARGE=400000       partial: charge portion
 *   (omit both to close the loan)
 *
 * Usage:
 *   PRINCIPAL=5000000 CHARGE=400000 pnpm run savings-loan-repay
 *   pnpm run savings-loan-repay    # closes
 */

import { repayLoan } from "@tx-meta/dcu-kit/savings";
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
  const savingsRef = state.scriptRefSavings
    ? (await lucid.utxosByOutRef([state.scriptRefSavings]))[0]
    : undefined;
  const fundTokenName = state.savingsFundTokenName;
  const memberTokenSuffix = state[savingsSuffixKey(wallet)];
  const loanTokenName = state.savingsLoanTokenName;
  if (!fundTokenName || !memberTokenSuffix || !loanTokenName) {
    throw new Error("Run savings-loan-disburse first.");
  }

  const closing = !process.env.PRINCIPAL && !process.env.CHARGE;
  const tx = await repayLoan(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    memberTokenSuffix,
    loanTokenName,
    ...(closing
      ? {}
      : {
          principal: BigInt(process.env.PRINCIPAL ?? 0),
          charge: BigInt(process.env.CHARGE ?? 0),
        }),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  if (closing) {
    clearState(["savingsLoanTokenName"]);
    console.log("Loan closed — record burned, book cleared.");
  } else {
    console.log("Partial repayment confirmed.");
  }
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
