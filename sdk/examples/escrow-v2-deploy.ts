/**
 * Deploy Escrow V2 Reference Script
 *
 * Parks the escrow v2 spending script (11.4 KB) in a reference-script UTxO at
 * the deployer's OWN address. Pool allocations must witness both the vault and
 * the escrow scripts in one transaction — inline that breaks the 16 KB tx
 * ceiling, so the escrow script has to ride as a reference input.
 *
 * The UTxO stays owned by the deployer (recoverable any time); Lucid bumps the
 * locked lovelace to the min-ADA the script size demands (~50 ADA). Wallet
 * balance displays exclude reference-script UTxOs from coin selection.
 *
 * Usage:
 *   pnpm run escrow-v2-deploy
 */

import { escrowV2Validator, escrowV2PolicyId } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, saveState } from "./state.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");
  const ownAddress = await lucid.wallet().address();

  const existing = loadState().scriptRefEscrowV2;
  if (existing) {
    const [utxo] = await lucid.utxosByOutRef([existing]);
    if (utxo?.scriptRef) {
      console.log(
        `Escrow v2 reference script already deployed at ${existing.txHash}#${existing.outputIndex} — nothing to do.`,
      );
      return;
    }
    console.log("Recorded ref-script UTxO is gone — redeploying.");
  }

  console.log(`Escrow v2 policy: ${escrowV2PolicyId}`);
  console.log("Deploying the v2 spend script as a reference script...");
  const tx = await lucid
    .newTx()
    .pay.ToAddressWithData(
      ownAddress,
      undefined,
      {},
      escrowV2Validator.spendEscrow,
    )
    .complete();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ scriptRefEscrowV2: { txHash, outputIndex: 0 } });
  console.log(
    "Reference script deployed. pool-allocate (and any v2 tx that wants a smaller footprint) will use it.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
