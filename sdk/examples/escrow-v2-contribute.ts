/**
 * Contribute (V2) Example
 *
 * Tops up a PerMilestone escrow with more of the escrowed asset — the funder
 * funds tranches as work progresses instead of locking everything upfront.
 * The datum is untouched; the balance strictly grows.
 *
 * Wallet selection: ACTIVE_WALLET must be the funder (default USER1).
 *
 * Env:
 *   AMOUNT=2000000              lovelace to add (required)
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   AMOUNT=2000000 pnpm run escrow-v2-contribute
 */

import { contribute } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const amount = BigInt(process.env.AMOUNT ?? "0");
  if (amount <= 0n)
    throw new Error("AMOUNT (lovelace, > 0) is required for contribute.");

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  console.log(`Contributing ${Number(amount) / 1e6} ADA to the escrow...`);
  const tx = await contribute(lucid, { stateTokenName, amount }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Contribution locked.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
