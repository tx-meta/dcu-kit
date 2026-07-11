/**
 * Savings Social Payout Example
 *
 * The quorum pays a welfare claim from the social fund. Valid while Active
 * AND during share-out — welfare does not stop for cycle close. Member
 * savings and the share-out pot are out of the quorum's reach on-chain.
 *
 * Wallet selection: ACTIVE_WALLET must satisfy the quorum credential
 * (default USER1, the creation default).
 *
 * Env:
 *   AMOUNT=1000000        payment in base units of the fund asset
 *   DESTINATION=addr...   beneficiary (default: own wallet address)
 *
 * Usage:
 *   AMOUNT=1000000 DESTINATION=addr_test1... pnpm run savings-social
 */

import { socialPayout } from "@tx-meta/dcu-kit/savings";
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

  const tx = await socialPayout(lucid, {
    fundTokenName: state.savingsFundTokenName,
    amount: BigInt(process.env.AMOUNT ?? 1_000_000),
    destination: process.env.DESTINATION ?? (await lucid.wallet().address()),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);
  console.log("Social payout confirmed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
