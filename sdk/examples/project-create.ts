/**
 * Create Project Example
 *
 * Mints a Project anchor — the passive identity NFT that groups escrows.
 * Escrows cite it by its opaque token name (projectId), never by UTxO
 * reference, so no project change can ever break an escrow.
 *
 * Wallet selection: ACTIVE_WALLET is the owner (default USER1).
 *
 * Env:
 *   TITLE="..."       max 64 UTF-8 bytes (default shown below)
 *   CONTENT="..."     any text — the script anchors its SHA-256 as the doc hash
 *
 * Usage:
 *   TITLE="Water kiosk build" pnpm run project-create
 */

import { createHash } from "node:crypto";
import { createProject } from "@tx-meta/dcu-kit/escrow/v2";
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

  const title = process.env.TITLE ?? "Preprod sweep project";
  const contentHash = process.env.CONTENT
    ? createHash("sha256").update(process.env.CONTENT).digest("hex")
    : undefined;

  console.log(`Creating project anchor: "${title}"`);
  const { tx, projectTokenName } = await createProject(lucid, {
    title,
    ...(contentHash ? { contentHash } : {}),
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);

  saveState({ projectTokenName });
  console.log("Project anchor minted. Token name:", projectTokenName);
  console.log(
    "Escrows created with USE_PROJECT=1 will cite it as their projectId.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
