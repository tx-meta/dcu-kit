/**
 * Pool Deposit Example
 *
 * Commits funds to a pool. The deposit stays YOURS — an individually-owned
 * vault UTxO carrying your refund identity. You can exit it unilaterally any
 * time (past the optional lock) until the quorum allocates it into an escrow.
 * This is the investor protection a shared multisig can't give.
 *
 * Wallet selection: ACTIVE_WALLET is the contributor (default USER1).
 *
 * Env:
 *   AMOUNT=15000000        lovelace to commit (required)
 *   LOCK_MINUTES=0         optional commitment window (no exit before it)
 *   POOL_TOKEN=...         overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=USER2 AMOUNT=8000000 pnpm run pool-deposit
 */

import { depositToPool } from "@tx-meta/dcu-kit/escrow/v2";
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
    throw new Error("AMOUNT (lovelace, > 0) is required for pool-deposit.");

  const poolTokenName = requireToken(
    "POOL_TOKEN",
    loadState().poolTokenName,
    "run pool-create first.",
  );

  const lockedUntil = process.env.LOCK_MINUTES
    ? BigInt(Date.now() + Number(process.env.LOCK_MINUTES) * 60_000)
    : undefined;

  console.log(
    `Committing ${Number(amount) / 1e6} ADA to the pool` +
      (lockedUntil ? ` (locked for ${process.env.LOCK_MINUTES}m)` : "") +
      "...",
  );
  const tx = await depositToPool(lucid, {
    poolTokenName,
    amount,
    ...(lockedUntil ? { lockedUntil } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log(
    "Deposit committed — still yours; exit any time with pool-exit until allocated.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
