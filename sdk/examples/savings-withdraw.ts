/**
 * Savings Withdraw Example
 *
 * Sells share units back before cycle close. Only valid on funds created
 * with WITHDRAWAL_POLICY=1 (ASCA flexible); the VSLA preset locks savings
 * until share-out.
 *
 * Wallet selection: ACTIVE_WALLET (default USER1) — must hold the units.
 *
 * Env:
 *   UNITS=4    share units to sell back
 *
 * Usage:
 *   UNITS=4 pnpm run savings-withdraw
 */

import { withdrawSavings } from "@tx-meta/dcu-kit/savings";
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
  const fundTokenName = state.savingsFundTokenName;
  const memberTokenSuffix = state[savingsSuffixKey(wallet)];
  if (!fundTokenName || !memberTokenSuffix) {
    throw new Error("Run savings-create and savings-join first.");
  }

  const tx = await withdrawSavings(lucid, {
    fundTokenName,
    memberTokenSuffix,
    units: BigInt(process.env.UNITS ?? 1),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Withdrawal confirmed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
