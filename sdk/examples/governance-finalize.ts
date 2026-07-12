/**
 * Finalize Proposal Example
 *
 * Permissionless. After the deadline, compares the FROZEN quorum and threshold to
 * the cast tally and transitions Open -> Passed | Rejected. No value moves.
 *
 * Usage:
 *   pnpm run governance-finalize
 */

import { buildGovernance, finalizeProposal } from "@tx-meta/dcu-kit/governance";
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

  const { tx, passed } = await finalizeProposal(lucid, {
    instance,
    proposalId: state.governanceProposalId,
  }).unsafeRun();

  console.log(`Finalizing — outcome: ${passed ? "PASSED" : "REJECTED"}`);
  const signed = await tx.sign.withWallet().complete();
  const txHash = await signed.submit();
  console.log("Transaction submitted. Hash:", txHash);
  console.log("View on Cexplorer:", cexplorerTxUrl(txHash));
  await lucid.awaitTx(txHash);

  console.log(
    passed
      ? "Proposal Passed. Emit its decision with governance-execute."
      : "Proposal Rejected. Retire it with governance-expire.",
  );
}

main().catch((e) => {
  logError(e);
  process.exit(1);
});
