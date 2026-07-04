/**
 * Reclaim Escrow Example
 *
 * Strictly after expiry, the funder takes back whatever the verifier never
 * released. The escrow's state token burns — this ends the escrow.
 *
 * Wallet selection:
 *   Default (USER1): the funder (the escrow's refund address)
 *
 * Env:
 *   ESCROW_STATE_TOKEN=...  overrides the state.json value from escrow-create
 *
 * Usage:
 *   pnpm run escrow-reclaim
 */

import { Effect } from "effect";
import {
  ReclaimEscrowConfig,
  reclaimEscrow,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow";
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

  const stateTokenName =
    process.env.ESCROW_STATE_TOKEN ?? loadState().escrowStateTokenName;
  if (!stateTokenName)
    throw new Error(
      "No escrowStateTokenName in state.json (and ESCROW_STATE_TOKEN not set). Run escrow-create first.",
    );

  const escrow = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  if (!escrow.expired) {
    const msLeft = Number(escrow.expiry) - Date.now();
    throw new Error(
      `Escrow has not expired yet — reclaim opens in ~${Math.ceil(msLeft / 3_600_000)}h.`,
    );
  }
  console.log(`Reclaiming remaining balance: ${escrow.remainingBalance}.`);

  const config: ReclaimEscrowConfig = { stateTokenName };

  console.log("Building reclaim transaction...");
  const tx = await reclaimEscrow(lucid, config).unsafeRun();

  console.log("Signing and submitting...");
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Escrow reclaimed and closed.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
