/**
 * Create Pool Example
 *
 * Opens a pooled commitment vault: investors commit individually-owned
 * deposits, and the pool's quorum (a key today, a multisig or vote script by
 * rotation) can allocate them ONLY into milestone escrows at the enforced
 * escrow target. No merged pot, no custodian — contributors keep unilateral
 * exit until the moment of allocation.
 *
 * Wallet selection: ACTIVE_WALLET pays the anchor min-ADA (default USER1).
 *
 * Env:
 *   TITLE="..."                 max 64 UTF-8 bytes
 *   QUORUM=ADMIN|addr...        allocation authority (default: own wallet)
 *   FUNDING_DEADLINE_MINUTES=60 allocations close after this (optional)
 *   CONTENT="..."               charter text — its SHA-256 is anchored
 *
 * Usage:
 *   QUORUM=ADMIN pnpm run pool-create
 */

import { createHash } from "node:crypto";
import { createPool } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { saveState } from "./state.js";
import { resolvePartyAddress } from "./escrow-v2-common.js";

async function main() {
  const { lucid, isEmulator } = await makeLucid();
  if (isEmulator) {
    console.log(
      "These example scripts require existing on-chain state. Run on Preprod.",
    );
    process.exit(0);
  }
  await selectEnvWallet(lucid, "USER1");

  const title = process.env.TITLE ?? "Preprod sweep pool";
  const contentHash = process.env.CONTENT
    ? createHash("sha256").update(process.env.CONTENT).digest("hex")
    : undefined;
  const fundingDeadline = process.env.FUNDING_DEADLINE_MINUTES
    ? BigInt(Date.now() + Number(process.env.FUNDING_DEADLINE_MINUTES) * 60_000)
    : undefined;

  console.log(
    `Creating pool "${title}"` +
      (process.env.QUORUM
        ? ` with quorum ${process.env.QUORUM}`
        : " (own-wallet quorum)"),
  );
  const { tx, poolTokenName } = await createPool(lucid, {
    title,
    ...(process.env.QUORUM
      ? { quorum: resolvePartyAddress(process.env.QUORUM) }
      : {}),
    ...(contentHash ? { contentHash } : {}),
    ...(fundingDeadline ? { fundingDeadline } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ poolTokenName });
  console.log("Pool vault open. Token name:", poolTokenName);
  console.log("Contributors commit with pool-deposit; the quorum allocates.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
