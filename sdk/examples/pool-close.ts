/**
 * Close Pool Example
 *
 * Burns the pool anchor (quorum-authorized) and recovers its min-ADA. Any
 * remaining deposits are UNAFFECTED — individually owned and exitable forever;
 * only new allocations die with the anchor. Prefer `STATUS=Closed pnpm run
 * pool-update` when the record should stay visible.
 *
 * Wallet selection: ACTIVE_WALLET must be the quorum (default ADMIN).
 *
 * Env:
 *   POOL_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN pnpm run pool-close
 */

import { closePool } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState, clearState } from "./state.js";
import { requireToken } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "ADMIN");

  const poolTokenName = requireToken(
    "POOL_TOKEN",
    loadState().poolTokenName,
    "run pool-create first.",
  );

  console.log("Burning the pool anchor...");
  const tx = await closePool(lucid, { poolTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  clearState(["poolTokenName"]);
  console.log(
    "Pool anchor burned. Remaining deposits stay exitable via pool-exit (set POOL_TOKEN).",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
