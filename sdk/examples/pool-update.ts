/**
 * Update Pool Example
 *
 * Quorum-authorized edit of the pool anchor: charter (title / doc hash),
 * status, and QUORUM ROTATION — the governance handoff. Rotating the quorum
 * to a multisig or (later) a vote-script hash upgrades the pool's governance
 * without touching deposits. Asset and escrow target are immutable identity.
 *
 * Wallet selection: ACTIVE_WALLET must be the current quorum (default ADMIN).
 *
 * Env:
 *   TITLE="..."             new title
 *   STATUS=Active|Closed    Closed stops new deposits/allocations
 *   NEW_QUORUM=USER1|addr   rotate the ratification authority
 *   POOL_TOKEN=...          overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=ADMIN STATUS=Closed pnpm run pool-update
 */

import { updatePool } from "@tx-meta/dcu-kit/escrow/v2";
import {
  makeLucid,
  cexplorerTxUrl,
  logError,
  selectEnvWallet,
} from "./context.js";
import { loadState } from "./state.js";
import { resolvePartyAddress, requireToken } from "./escrow-v2-common.js";

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

  const title = process.env.TITLE;
  const status = process.env.STATUS as "Active" | "Closed" | undefined;
  const newQuorum = process.env.NEW_QUORUM;
  if (!title && !status && !newQuorum)
    throw new Error("Set at least one of TITLE, STATUS, NEW_QUORUM.");

  console.log(
    `Updating pool${title ? ` title="${title}"` : ""}${status ? ` status=${status}` : ""}${newQuorum ? ` quorum→${newQuorum}` : ""}...`,
  );
  const tx = await updatePool(lucid, {
    poolTokenName,
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(newQuorum ? { newQuorum: resolvePartyAddress(newQuorum) } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Pool updated. Deposits are unaffected.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
