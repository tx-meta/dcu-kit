/**
 * Pool Exit Example
 *
 * The contributor's unilateral exit: recover ONE of your unallocated deposits
 * from the pool — no quorum involvement, no permission needed (past any
 * commitment window). Run again to exit further deposits.
 *
 * Wallet selection: ACTIVE_WALLET is the contributor (default USER1).
 *
 * Env:
 *   POOL_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=USER2 pnpm run pool-exit
 */

import { exitDeposit } from "@tx-meta/dcu-kit/escrow/v2";
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

  const poolTokenName = requireToken(
    "POOL_TOKEN",
    loadState().poolTokenName,
    "run pool-create first.",
  );

  console.log("Exiting one of this wallet's deposits...");
  const tx = await exitDeposit(lucid, { poolTokenName }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Deposit recovered to the contributor's wallet.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
