/**
 * Execute Decision Example
 *
 * Mints the one-shot Decision token for a Passed proposal — bound to the
 * proposal's (target, action) — and locks it at the gate address. This is the
 * only step that creates authorization. The decision is later spent AND BURNED
 * by the gated vault action (governance-authorize), so it can never be replayed.
 *
 * Usage:
 *   pnpm run governance-execute
 */

import { buildGovernance, executeDecision } from "@tx-meta/dcu-kit/governance";
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

  const state = loadState();
  if (!state.governanceSeed || !state.governanceProposalId) {
    throw new Error("Run governance-init and governance-propose first.");
  }
  const instance = buildGovernance(state.governanceSeed);

  const { tx, decisionName } = await executeDecision(lucid, {
    instance,
    proposalId: state.governanceProposalId,
  }).unsafeRun();

  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  console.log("Decision emitted:", decisionName);
  console.log("It now sits at the gate address:", instance.gateHash);
  console.log("Consume it with governance-authorize (burns it, one-shot).");
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
