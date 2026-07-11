/**
 * Submit Evidence (V2) Example
 *
 * The beneficiary anchors a deliverable hash against an unreleased milestone —
 * a timestamped, on-chain "work delivered" record the verifier and any future
 * arbiter can check. Overwritable until that milestone releases; moves no
 * funds (an assertion can't authorize funds).
 *
 * Wallet selection: ACTIVE_WALLET must be the beneficiary (default USER2).
 *
 * Env:
 *   MILESTONE_INDEX=0           which milestone (default: the current one)
 *   EVIDENCE="ipfs://Qm..."     any text — the script anchors its SHA-256
 *   EVIDENCE_HASH=hex           or pass the hash yourself
 *   ESCROW_V2_STATE_TOKEN=...   overrides state.json
 *
 * Usage:
 *   ACTIVE_WALLET=USER2 EVIDENCE="ipfs://QmDeliverable" pnpm run escrow-v2-evidence
 */

import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  submitEvidence,
  getEscrowStateProgram,
} from "@tx-meta/dcu-kit/escrow/v2";
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
  await selectEnvWallet(lucid, "USER2");

  const stateTokenName = requireToken(
    "ESCROW_V2_STATE_TOKEN",
    loadState().escrowV2StateTokenName,
    "run escrow-v2-create first.",
  );

  const evidenceHash =
    process.env.EVIDENCE_HASH ??
    createHash("sha256")
      .update(process.env.EVIDENCE ?? "sweep deliverable")
      .digest("hex");

  const s = await Effect.runPromise(
    getEscrowStateProgram(lucid, { stateTokenName }),
  );
  const milestoneIndex = Number(process.env.MILESTONE_INDEX ?? s.releasedCount);

  console.log(`Anchoring evidence for m${milestoneIndex}: ${evidenceHash}`);
  const tx = await submitEvidence(lucid, {
    stateTokenName,
    milestoneIndex,
    evidenceHash,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));

  console.log("Waiting for confirmation...");
  await lucid.awaitTx(txHash);
  console.log("Evidence anchored on-chain.");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
