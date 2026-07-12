/**
 * Savings Deploy Example
 *
 * Deploys the savings-credit validator as a reference script (once). The
 * ~15.6KB script cannot ride inline within the 16KB tx limit, so every
 * other savings script resolves this reference from state.json.
 *
 * Wallet selection: ACTIVE_WALLET pays the ~17 ADA ref deposit (default USER1).
 *
 * Usage:
 *   pnpm run savings-deploy
 */

import { savingsVaultValidator } from "@tx-meta/dcu-kit/savings";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");
  const address = await lucid.wallet().address();

  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      address,
      undefined,
      { lovelace: 20_000_000n },
      savingsVaultValidator.spendVault,
    )
    .complete();
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  saveState({ scriptRefSavings: { txHash, outputIndex: 0 } });
  console.log("Savings validator deployed as a reference script.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
