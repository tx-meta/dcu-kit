/**
 * Savings Loan Disburse Example
 *
 * The loan committee (quorum) disburses a loan to the active member:
 * principal to the borrower's wallet, a loan record UTxO to the vault.
 * Requires BOTH the quorum's and the borrower's signatures — in the sweep
 * the fund's default quorum is USER1, so running as USER1 (borrower =
 * quorum) needs only one signature. Eligibility: principal <=
 * max_loan_multiple x the borrower's share value.
 *
 * Wallet selection: ACTIVE_WALLET is the borrower (default USER1).
 *
 * Env:
 *   PRINCIPAL=8000000       base units of the fund asset
 *   CHARGE=400000           flat service charge (fixed at disbursement)
 *   DUE_MINUTES=60          repayment deadline from now (min ~16)
 *
 * Usage:
 *   PRINCIPAL=8000000 CHARGE=400000 DUE_MINUTES=60 pnpm run savings-loan-disburse
 */

import { disburseLoan } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState, savingsSuffixKey } from "./state.js";

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

  const dueMinutes = Number(process.env.DUE_MINUTES ?? 60);
  const { tx, loanTokenName } = await disburseLoan(lucid, {
    scriptRef: savingsRef,
    fundTokenName,
    memberTokenSuffix,
    principal: BigInt(process.env.PRINCIPAL ?? 8_000_000),
    serviceCharge: BigInt(process.env.CHARGE ?? 400_000),
    due: BigInt(Date.now() + dueMinutes * 60_000),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({ savingsLoanTokenName: loanTokenName });
  console.log("Loan disbursed. Record token:", loanTokenName);
  console.log("Repay with savings-loan-repay before the deadline.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
